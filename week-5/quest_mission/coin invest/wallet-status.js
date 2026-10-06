// 지갑 평가 현황을 JSON 으로 출력한다. (투자 에이전트 · 리포트용)
//   node wallet-status.js
// 서버(/api/wallet)에서 잔고를, 업비트에서 현재가를 받아 총자산과 누적 수익률을 계산한다.

const BASE = process.env.COIN_API || 'http://localhost:3014';
const INITIAL_CASH = 10_000_000; // server.js 의 INITIAL_CASH 와 같아야 한다

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

(async () => {
  const { data: wallet } = await getJson(`${BASE}/api/wallet`);
  const markets = wallet.holdings.map((h) => h.market);
  const tickers = markets.length
    ? await getJson(`https://api.upbit.com/v1/ticker?markets=${markets.join(',')}`)
    : [];
  const priceOf = new Map(tickers.map((t) => [t.market, t.trade_price]));

  const holdings = wallet.holdings.map((h) => {
    const price = priceOf.get(h.market) ?? 0;
    const value = Math.round(h.balance * price);
    const cost = Math.round(h.balance * h.avg_buy_price);
    return {
      market: h.market,
      korean_name: h.korean_name,
      balance: h.balance,
      avg_buy_price: h.avg_buy_price,
      price,
      value,
      profit: value - cost,
      profit_rate: cost ? Number((((value - cost) / cost) * 100).toFixed(2)) : 0,
    };
  });

  const coinValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const total = Math.round(wallet.cash) + coinValue;

  console.log(JSON.stringify({
    checked_at: new Date().toISOString(),
    cash: Math.round(wallet.cash),
    coin_value: coinValue,
    total,
    initial: INITIAL_CASH,
    profit: total - INITIAL_CASH,
    profit_rate: Number((((total - INITIAL_CASH) / INITIAL_CASH) * 100).toFixed(2)), // 누적 수익률(%)
    holdings,
  }, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
