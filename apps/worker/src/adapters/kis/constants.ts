/**
 * KIS 전용 상수 — 도메인/tr_id. 이 파일 밖으로 새지 않는다(증권사 중립 원칙, 4장·10장-9).
 * tr_id 는 paper(모의)/prod(실거래)별로 다르다. 1차는 paper 만 사용.
 */
export const KIS_DOMAIN = {
  paper: 'https://openapivts.koreainvestment.com:29443',
  prod: 'https://openapi.koreainvestment.com:9443',
} as const;

/** 거래/조회 tr_id. paper 전용 값만 1차에서 사용. */
export const TR_ID = {
  paper: {
    buy: 'VTTC0802U',
    sell: 'VTTC0801U',
    balance: 'VTTC8434R',
    orderList: 'VTTC8001R', // 일별 주문체결 조회
  },
  prod: {
    buy: 'TTTC0802U',
    sell: 'TTTC0801U',
    balance: 'TTTC8434R',
    orderList: 'TTTC8001R',
  },
  // 시세는 paper/prod 공통
  quote: 'FHKST01010100',
  dailyChart: 'FHKST03010100',
  minuteChart: 'FHKST03010200',
} as const;
