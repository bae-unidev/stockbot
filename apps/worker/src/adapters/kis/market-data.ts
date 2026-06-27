/**
 * KIS 시세 조회 → 도메인 타입 매핑. raw(한글약어) 는 이 파일 안에서만 다룬다.
 * 현재가(getQuote)와 일/분봉 차트를 도메인 Quote/Bar 로 변환해 반환.
 */
import { TR_ID } from './constants.js';
import { ChartResponse, QuoteResponse } from './schemas.js';
import type { KisClient } from './client.js';
import type { Bar, Quote, Symbol } from '@stockbot/core';

/** YYYYMMDD + HHMMSS (KST) → UTC epoch ms. */
function kstToEpoch(date: string, time = '000000'): number {
  const y = +date.slice(0, 4);
  const mo = +date.slice(4, 6);
  const d = +date.slice(6, 8);
  const h = +time.slice(0, 2);
  const mi = +time.slice(2, 4);
  const s = +time.slice(4, 6);
  // KST = UTC+9
  return Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3600_000;
}

/** 밸류/퀄리티 팩터용 펀더멘털(전부 null 가능 — 미제공 시 중립 처리). */
export interface Fundamentals {
  per: number | null;
  pbr: number | null;
  /** ROE 근사: EPS/BPS×100(%). 별도 ROE 미제공이므로 추정치. */
  roe: number | null;
}

export class KisMarketDataApi {
  constructor(private readonly client: KisClient) {}

  /** 현재가 응답의 PER/PBR/EPS/BPS 로 펀더멘털 구성. EPS/BPS 로 ROE 근사. */
  async getFundamentals(symbol: Symbol): Promise<Fundamentals | null> {
    const res = await this.client.request<unknown>({
      method: 'GET',
      path: '/uapi/domestic-stock/v1/quotations/inquire-price',
      trId: TR_ID.quote,
      query: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol },
    });
    const parsed = QuoteResponse.parse(res);
    if (!parsed.output) return null;
    const o = parsed.output;
    const num = (v?: string): number | null => {
      if (v == null || v.trim() === '') return null;
      const n = Number(v);
      return Number.isFinite(n) && n !== 0 ? n : null;
    };
    const eps = num(o.eps);
    const bps = num(o.bps);
    const roe = eps != null && bps != null ? (eps / bps) * 100 : null;
    return { per: num(o.per), pbr: num(o.pbr), roe };
  }

  async getQuote(symbol: Symbol): Promise<Quote | null> {
    const res = await this.client.request<unknown>({
      method: 'GET',
      path: '/uapi/domestic-stock/v1/quotations/inquire-price',
      trId: TR_ID.quote,
      query: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol },
    });
    const parsed = QuoteResponse.parse(res);
    if (!parsed.output) return null;
    const o = parsed.output;
    return {
      symbol,
      ts: Date.now(),
      last: Number(o.stck_prpr),
      tradingValue: o.acml_tr_pbmn ? Number(o.acml_tr_pbmn) : undefined,
    };
  }

  /** 일봉 조회(기간). from/to: YYYYMMDD(KST). adjusted=수정주가 적용. */
  async getDailyBars(symbol: Symbol, from: string, to: string, adjusted = true): Promise<Bar[]> {
    const res = await this.client.request<unknown>({
      method: 'GET',
      path: '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
      trId: TR_ID.dailyChart,
      query: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: from,
        FID_INPUT_DATE_2: to,
        FID_PERIOD_DIV_CODE: 'D',
        FID_ORG_ADJ_PRC: adjusted ? '0' : '1', // 0=수정주가 반영
      },
    });
    const parsed = ChartResponse.parse(res);
    const rows = parsed.output2 ?? [];
    return rows
      .filter((r) => r.stck_bsop_date)
      .map<Bar>((r) => ({
        symbol,
        timeframe: 'D',
        ts: kstToEpoch(r.stck_bsop_date!),
        open: Number(r.stck_oprc),
        high: Number(r.stck_hgpr),
        low: Number(r.stck_lwpr),
        close: Number(r.stck_clpr ?? r.stck_prpr ?? r.stck_oprc),
        volume: Number(r.acml_vol ?? 0),
        adjusted,
        source: 'kis',
      }))
      .sort((a, b) => a.ts - b.ts);
  }

  /**
   * 당일 분봉 조회(최근 구간). KIS 는 한 번에 최근 ~30건 반환.
   * 반환은 1m 도메인 봉 — 시간봉 집계는 collector 가 수행(7장).
   */
  async getTodayMinuteBars(symbol: Symbol, endHHMMSS = '153000'): Promise<Bar[]> {
    const res = await this.client.request<unknown>({
      method: 'GET',
      path: '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice',
      trId: TR_ID.minuteChart,
      query: {
        FID_ETC_CLS_CODE: '',
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: symbol,
        FID_INPUT_HOUR_1: endHHMMSS,
        FID_PW_DATA_INCU_YN: 'Y',
      },
    });
    const parsed = ChartResponse.parse(res);
    const rows = parsed.output2 ?? [];
    const today = new Date();
    const yyyymmdd = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;
    return rows
      .filter((r) => r.stck_cntg_hour)
      .map<Bar>((r) => ({
        symbol,
        timeframe: '1m',
        ts: kstToEpoch(r.stck_bsop_date ?? yyyymmdd, r.stck_cntg_hour!),
        open: Number(r.stck_oprc),
        high: Number(r.stck_hgpr),
        low: Number(r.stck_lwpr),
        close: Number(r.stck_prpr ?? r.stck_clpr ?? r.stck_oprc),
        volume: Number(r.cntg_vol ?? r.acml_vol ?? 0),
        adjusted: false,
        source: 'kis',
      }))
      .sort((a, b) => a.ts - b.ts);
  }
}
