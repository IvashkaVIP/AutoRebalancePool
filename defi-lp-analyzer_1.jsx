const { useState, useEffect, useCallback } = React;

const DEFAULT_WALLET = "0x26f24bcadb806ea9287fa68883a3a4f775024f34";
const CHAIN_ID = 8453; // Base

// Uniswap V3 Subgraph for Base (The Graph)
const SUBGRAPH_URL =
  "https://gateway.thegraph.com/api/public/subgraphs/id/43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG";
// Fallback: Uniswap official hosted endpoint
const SUBGRAPH_FALLBACK =
  "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-base";

async function fetchSubgraph(query, variables = {}) {
  const endpoints = [
    "https://gateway.thegraph.com/api/public/subgraphs/id/43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG",
    "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-base",
    "https://subgraph.satsuma-prod.com/uniswap/uniswap-v3-base/api",
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.data) return data.data;
    } catch (e) {
      continue;
    }
  }
  return null;
}

const POSITIONS_QUERY = `
  query GetPositions($owner: String!) {
    positions(where: { owner: $owner, liquidity_gt: "0" }, first: 50, orderBy: liquidity, orderDirection: desc) {
      id
      owner
      liquidity
      tickLower { tickIdx price0 price1 }
      tickUpper { tickIdx price0 price1 }
      token0 { id symbol decimals }
      token1 { id symbol decimals }
      pool {
        id
        feeTier
        token0Price
        token1Price
        tick
        sqrtPrice
      }
      depositedToken0
      depositedToken1
      withdrawnToken0
      withdrawnToken1
      collectedFeesToken0
      collectedFeesToken1
      feeGrowthInside0LastX128
      feeGrowthInside1LastX128
    }
  }
`;

const ALL_POSITIONS_QUERY = `
  query GetAllPositions($owner: String!) {
    positions(where: { owner: $owner }, first: 50) {
      id
      owner
      liquidity
      tickLower { tickIdx price0 price1 }
      tickUpper { tickIdx price0 price1 }
      token0 { id symbol decimals }
      token1 { id symbol decimals }
      pool {
        id
        feeTier
        token0Price
        token1Price
        tick
        sqrtPrice
      }
      depositedToken0
      depositedToken1
    }
  }
`;

function tickToPrice(tick) {
  return Math.pow(1.0001, tick);
}

function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
  const sq = parseFloat(sqrtPriceX96) / Math.pow(2, 96);
  const rawPrice = sq * sq;
  const adjPrice = rawPrice * Math.pow(10, decimals0 - decimals1);
  return adjPrice;
}

function calcTokenAmounts(liquidity, sqrtPrice, sqrtLower, sqrtUpper) {
  const L = parseFloat(liquidity);
  const sp = parseFloat(sqrtPrice) / Math.pow(2, 96);
  const sa = Math.sqrt(sqrtLower);
  const sb = Math.sqrt(sqrtUpper);
  let amount0 = 0,
    amount1 = 0;
  if (sp <= sa) {
    amount0 = L * (1 / sa - 1 / sb);
  } else if (sp >= sb) {
    amount1 = L * (sb - sa);
  } else {
    amount0 = L * (1 / sp - 1 / sb);
    amount1 = L * (sp - sa);
  }
  return { amount0, amount1 };
}

async function fetchETHPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    );
    const d = await res.json();
    return d?.ethereum?.usd || 1900;
  } catch (e) {
    try {
      const res2 = await fetch(
        "https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD",
      );
      const d2 = await res2.json();
      return d2?.USD || 1900;
    } catch (e2) {
      return 1900;
    }
  }
}

function StatusBadge({ status }) {
  return status === "В ДИАПАЗОНЕ" ? (
    <span style={{ color: "#22c55e", fontWeight: 700 }}>В ДИАПАЗОНЕ ✅</span>
  ) : (
    <span style={{ color: "#f59e0b", fontWeight: 700 }}>ВНЕ ДИАПАЗОНА ⚠️</span>
  );
}

function ASCIIChart({ positions, ethPrice }) {
  if (!positions.length) return null;
  const allLowers = positions.map((p) => p.lowerUSD).filter(Boolean);
  const allUppers = positions.map((p) => p.upperUSD).filter(Boolean);
  if (!allLowers.length) return null;

  const minPrice = Math.min(...allLowers);
  const maxPrice = Math.max(...allUppers);
  const range = maxPrice - minPrice || 1;
  const WIDTH = 60;
  const currentPrice = positions[0]?.currentUSD || ethPrice;

  const bars = positions.map((pos, i) => {
    const left = Math.round(((pos.lowerUSD - minPrice) / range) * WIDTH);
    const right = Math.round(((pos.upperUSD - minPrice) / range) * WIDTH);
    const width = Math.max(1, right - left);
    const chars = ["█", "▓", "▒", "░", "▪", "◆"];
    return { left, width, char: chars[i % chars.length], id: pos.id, value: pos.valueUSD };
  });

  const currentX = Math.round(((currentPrice - minPrice) / range) * WIDTH);
  const clampedX = Math.max(0, Math.min(WIDTH, currentX));
  const maxVal = Math.max(...positions.map((p) => p.valueUSD || 1));

  const lines = [];
  lines.push("┌" + "─".repeat(WIDTH + 2) + "┐");
  positions.forEach((pos, i) => {
    const bar = bars[i];
    let row = " ".repeat(bar.left) + bar.char.repeat(bar.width);
    row = row.padEnd(WIDTH, " ");
    lines.push(`│ ${row} │ ← ${pos.pool} $${Math.round(pos.valueUSD || 0)}`);
  });

  let priceLine = " ".repeat(clampedX) + "▼";
  priceLine = priceLine.padEnd(WIDTH, " ");
  lines.push("│ " + priceLine + " │");
  lines.push("└" + "─".repeat(WIDTH + 2) + "┘");

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8, color: "#a78bfa" }}>📊 ВИЗУАЛИЗАЦИЯ ЛИКВИДНОСТИ</div>
      <pre style={{ background: "#0f172a", color: "#e2e8f0", padding: "12px 16px", borderRadius: 8, fontSize: 12, overflowX: "auto", border: "1px solid #334155" }}>
        {`  ▼ ТЕКУЩАЯ ЦЕНА: $${Math.round(currentPrice)}\n${lines.join("\n")}`}
      </pre>
    </div>
  );
}

function ReportTable({ positions, loading }) {
  if (loading) return <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>⏳ Загружаем данные...</div>;
  if (!positions.length) return <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>🔍 Активные LP-позиции не найдены.</div>;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ background: "#1e293b", color: "#94a3b8" }}>
            {["ID", "Пул", "Комиссия", "Нижняя $", "Верхняя $", "Текущая $", "Статус", "WETH", "USDC", "USD"].map((h) => (
              <th key={h} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "1px solid #334155" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.map((pos, i) => (
            <tr key={pos.id} style={{ background: i % 2 === 0 ? "#0f172a" : "#1a2332", borderBottom: "1px solid #1e293b" }}>
              <td style={{ padding: "7px 10px", color: "#7dd3fc" }}>{pos.id}</td>
              <td style={{ padding: "7px 10px", fontWeight: 600 }}>{pos.pool}</td>
              <td style={{ padding: "7px 10px", color: "#34d399" }}>{pos.fee}%</td>
              <td style={{ padding: "7px 10px", color: "#fbbf24" }}>${pos.lowerUSD}</td>
              <td style={{ padding: "7px 10px", color: "#fbbf24" }}>${pos.upperUSD}</td>
              <td style={{ padding: "7px 10px", color: "#60a5fa" }}>${pos.currentUSD}</td>
              <td style={{ padding: "7px 10px" }}><StatusBadge status={pos.status} /></td>
              <td style={{ padding: "7px 10px" }}>{pos.amount0}</td>
              <td style={{ padding: "7px 10px" }}>{pos.amount1}</td>
              <td style={{ padding: "7px 10px", fontWeight: 700, color: "#22c55e" }}>${Math.round(pos.valueUSD)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Recommendations({ positions }) {
  if (!positions.length) return null;
  const outRange = positions.filter((p) => p.status !== "В ДИАПАЗОНЕ");

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: "#a78bfa" }}>💡 РЕКОМЕНДАЦИИ</div>
      <div style={{ background: "#1e293b", borderRadius: 8, padding: "16px", border: "1px solid #334155" }}>
        {outRange.length > 0 ? (
          <div style={{ color: "#f59e0b" }}>⚠️ {outRange.length} поз. вне диапазона! Рекомендуется ребалансировка.</div>
        ) : (
          <div style={{ color: "#22c55e" }}>✅ Все позиции в диапазоне. Активных действий не требуется.</div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [wallet, setWallet] = useState(DEFAULT_WALLET);
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ethPrice, setEthPrice] = useState(0);
  const [error, setError] = useState(null);

  const fetchPositions = useCallback(async () => {
    if (!wallet.startsWith("0x")) { setError("Неверный адрес"); return; }
    setLoading(true); setError(null);
    try {
      const [ethPriceVal, subgraphData] = await Promise.all([
        fetchETHPrice(),
        fetchSubgraph(POSITIONS_QUERY, { owner: wallet.toLowerCase() }),
      ]);
      setEthPrice(ethPriceVal);
      const raw = subgraphData?.positions || [];
      const processed = raw.map((pos) => {
        const dec0 = parseInt(pos.token0.decimals);
        const dec1 = parseInt(pos.token1.decimals);
        const tickLower = parseInt(pos.tickLower.tickIdx);
        const tickUpper = parseInt(pos.tickUpper.tickIdx);
        const tick = parseInt(pos.pool.tick);
        
        const lowerUSD = Math.pow(1.0001, tickLower) * Math.pow(10, dec0 - dec1);
        const upperUSD = Math.pow(1.0001, tickUpper) * Math.pow(10, dec0 - dec1);
        const currentUSD = Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
        
        const { amount0, amount1 } = calcTokenAmounts(pos.liquidity, BigInt(pos.pool.sqrtPrice), Math.pow(1.0001, tickLower), Math.pow(1.0001, tickUpper));
        
        const a0 = amount0 / Math.pow(10, dec0);
        const a1 = amount1 / Math.pow(10, dec1);
        
        return {
          id: `POS-${pos.id.slice(0, 6)}`,
          pool: `${pos.token0.symbol}/${pos.token1.symbol}`,
          fee: (pos.pool.feeTier / 10000).toFixed(2),
          lowerUSD: parseFloat(lowerUSD.toFixed(2)),
          upperUSD: parseFloat(upperUSD.toFixed(2)),
          currentUSD: parseFloat(currentUSD.toFixed(2)),
          status: (currentUSD >= lowerUSD && currentUSD <= upperUSD) ? "В ДИАПАЗОНЕ" : "ВНЕ ДИАПАЗОНА",
          amount0: parseFloat(a0.toFixed(4)),
          amount1: parseFloat(a1.toFixed(2)),
          valueUSD: a0 * currentUSD + a1
        };
      });
      setPositions(processed);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [wallet]);

  return (
    <div style={{ background: "#0b1120", minHeight: "100vh", color: "#e2e8f0", fontFamily: "sans-serif", padding: "20px" }}>
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <div style={{ marginBottom: 20, display: "flex", gap: 10, alignItems: "center" }}>
          <input 
            value={wallet} 
            onChange={(e) => setWallet(e.target.value)}
            style={{ flex: 1, background: "#1e293b", border: "1px solid #334155", color: "white", padding: "10px", borderRadius: 8 }}
            placeholder="Введите адрес кошелька (0x...)"
          />
          <button onClick={fetchPositions} disabled={loading} style={{ background: "#7c3aed", color: "white", border: "none", padding: "10px 20px", borderRadius: 8, cursor: "pointer", fontWeight: 700 }}>
            {loading ? "⌛" : "АНАЛИЗ"}
          </button>
        </div>
        {error && <div style={{ color: "#ef4444", marginBottom: 10 }}>⚠️ {error}</div>}
        <div style={{ background: "#1e293b", borderRadius: 10, padding: "16px", border: "1px solid #334155" }}>
          <ReportTable positions={positions} loading={loading} />
        </div>
        {positions.length > 0 && <ASCIIChart positions={positions} ethPrice={ethPrice} />}
        {positions.length > 0 && <Recommendations positions={positions} />}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
