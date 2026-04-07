import { useState, useEffect, useCallback } from "react";

const WALLET = "0x26f24bcadb806ea9287fa68883a3a4f775024f34";
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

async function fetchUniswapAPI(wallet) {
  // Try Uniswap v3 positions via official API
  try {
    const res = await fetch(
      `https://interface.gateway.uniswap.org/v1/graphql`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.uniswap.org",
        },
        body: JSON.stringify({
          query: `query PortfolioBalances($ownerAddress: String!, $chains: [Chain!]!) {
          portfolios(ownerAddresses: [$ownerAddress], chains: $chains) {
            tokenBalances { token { chain symbol address decimals } quantity denominatedValue { value } }
          }
        }`,
          variables: { ownerAddress: wallet, chains: ["BASE"] },
        }),
      },
    );
    if (res.ok) {
      const d = await res.json();
      return d?.data;
    }
  } catch (e) {}
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
    // fallback from another source
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
  const priceKey = (pos) => {
    const sym0 = pos.token0.symbol;
    return sym0 === "WETH" || sym0 === "ETH"
      ? {
          lower: pos.lowerUSD,
          upper: pos.upperUSD,
          current: pos.currentUSD,
          value: pos.valueUSD,
        }
      : {
          lower: pos.lowerUSD,
          upper: pos.upperUSD,
          current: pos.currentUSD,
          value: pos.valueUSD,
        };
  };

  const allLowers = positions.map((p) => p.lowerUSD).filter(Boolean);
  const allUppers = positions.map((p) => p.upperUSD).filter(Boolean);
  if (!allLowers.length) return null;

  const minPrice = Math.min(...allLowers);
  const maxPrice = Math.max(...allUppers);
  const range = maxPrice - minPrice;
  const WIDTH = 60;
  const currentPrice = positions[0]?.currentUSD || ethPrice;

  // Build bars
  const bars = positions.map((pos, i) => {
    const left = Math.round(((pos.lowerUSD - minPrice) / range) * WIDTH);
    const right = Math.round(((pos.upperUSD - minPrice) / range) * WIDTH);
    const width = Math.max(1, right - left);
    const chars = ["█", "▓", "▒", "░", "▪", "◆"];
    const char = chars[i % chars.length];
    return { left, width, char, id: pos.id, value: pos.valueUSD };
  });

  const currentX = Math.round(((currentPrice - minPrice) / range) * WIDTH);
  const clampedX = Math.max(0, Math.min(WIDTH, currentX));

  const maxVal = Math.max(...positions.map((p) => p.valueUSD || 1));

  const lines = [];
  lines.push("┌" + "─".repeat(WIDTH + 2) + "┐");

  positions.forEach((pos, i) => {
    const bar = bars[i];
    const heightRatio = (pos.valueUSD || 1) / maxVal;
    const barChar = bar.char;
    let row = " ".repeat(bar.left) + barChar.repeat(bar.width);
    row = row.padEnd(WIDTH, " ");
    const label = `${pos.pool} $${Math.round(pos.valueUSD || 0)}`;
    lines.push(`│ ${row} │ ← ${label}`);
  });

  // Current price line
  let priceLine = " ".repeat(clampedX) + "▼";
  priceLine = priceLine.padEnd(WIDTH, " ");
  lines.push("│ " + priceLine + " │");
  lines.push(
    "│ " + " ".repeat(clampedX) + "P".padEnd(WIDTH - clampedX, " ") + " │",
  );
  lines.push("└" + "─".repeat(WIDTH + 2) + "┘");

  // Price axis
  const leftLabel = `$${Math.round(minPrice)}`;
  const rightLabel = `$${Math.round(maxPrice)}`;
  const midLabel = `$${Math.round((minPrice + maxPrice) / 2)}`;
  const mid = Math.round(WIDTH / 2) - Math.round(midLabel.length / 2);
  let axis = leftLabel;
  axis += " ".repeat(Math.max(0, mid - leftLabel.length));
  axis += midLabel;
  axis += " ".repeat(Math.max(0, WIDTH - axis.length - rightLabel.length + 2));
  axis += rightLabel;

  const inRange = currentPrice >= minPrice && currentPrice <= maxPrice;
  const posText = inRange
    ? "внутри"
    : currentPrice < minPrice
      ? "ниже"
      : "выше";

  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          fontWeight: 700,
          fontSize: 15,
          marginBottom: 8,
          color: "#a78bfa",
        }}
      >
        📊 ВИЗУАЛИЗАЦИЯ РАСПРЕДЕЛЕНИЯ ЛИКВИДНОСТИ
      </div>
      <pre
        style={{
          background: "#0f172a",
          color: "#e2e8f0",
          padding: "12px 16px",
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.6,
          overflowX: "auto",
          border: "1px solid #334155",
        }}
      >
        {`  ▼ ТЕКУЩАЯ ЦЕНА: $${Math.round(currentPrice)}
${lines.join("\n")}
  ${axis}

  Легенда:`}
        {positions
          .map(
            (pos, i) =>
              `\n  ${bars[i].char} = ${pos.pool} (${pos.version}, ${pos.fee}%)`,
          )
          .join("")}
        {`\n\n  ➤ Текущая цена $${Math.round(currentPrice)} находится ${posText} основного скопления ликвидности`}
        {`\n  ➤ Диапазон всех позиций: $${Math.round(minPrice)} – $${Math.round(maxPrice)}`}
      </pre>
    </div>
  );
}

function ReportTable({ positions, ethPrice, loading }) {
  if (loading)
    return (
      <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
        <div>Загружаем данные из блокчейна...</div>
      </div>
    );
  if (!positions.length)
    return (
      <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
        <div>Активные LP-позиции не найдены для данного кошелька на Base.</div>
        <div style={{ marginTop: 8, fontSize: 12 }}>
          Возможно, позиции закрыты или находятся в другой сети.
        </div>
      </div>
    );

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
      >
        <thead>
          <tr style={{ background: "#1e293b", color: "#94a3b8" }}>
            {[
              "ID позиции",
              "Пул",
              "Версия",
              "Комиссия",
              "Нижняя $",
              "Верхняя $",
              "Текущая $",
              "Статус",
              "WETH",
              "USDC",
              "Стоимость USD",
            ].map((h) => (
              <th
                key={h}
                style={{
                  padding: "8px 10px",
                  textAlign: "left",
                  borderBottom: "1px solid #334155",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.map((pos, i) => (
            <tr
              key={pos.id}
              style={{
                background: i % 2 === 0 ? "#0f172a" : "#1a2332",
                borderBottom: "1px solid #1e293b",
              }}
            >
              <td
                style={{
                  padding: "7px 10px",
                  fontFamily: "monospace",
                  color: "#7dd3fc",
                  fontSize: 11,
                }}
              >
                {pos.id}
              </td>
              <td
                style={{
                  padding: "7px 10px",
                  fontWeight: 600,
                  color: "#e2e8f0",
                }}
              >
                {pos.pool}
              </td>
              <td style={{ padding: "7px 10px", color: "#a78bfa" }}>
                {pos.version}
              </td>
              <td style={{ padding: "7px 10px", color: "#34d399" }}>
                {pos.fee}%
              </td>
              <td style={{ padding: "7px 10px", color: "#fbbf24" }}>
                ${pos.lowerUSD?.toFixed(2)}
              </td>
              <td style={{ padding: "7px 10px", color: "#fbbf24" }}>
                ${pos.upperUSD?.toFixed(2)}
              </td>
              <td
                style={{
                  padding: "7px 10px",
                  color: "#60a5fa",
                  fontWeight: 600,
                }}
              >
                ${pos.currentUSD?.toFixed(2)}
              </td>
              <td style={{ padding: "7px 10px" }}>
                <StatusBadge status={pos.status} />
              </td>
              <td style={{ padding: "7px 10px", color: "#e2e8f0" }}>
                {pos.amount0?.toFixed(4)}
              </td>
              <td style={{ padding: "7px 10px", color: "#e2e8f0" }}>
                {pos.amount1?.toFixed(2)}
              </td>
              <td
                style={{
                  padding: "7px 10px",
                  fontWeight: 700,
                  color: "#22c55e",
                }}
              >
                ~${Math.round(pos.valueUSD || 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Recommendations({ positions }) {
  if (!positions.length) return null;
  const inRange = positions.filter((p) => p.status === "В ДИАПАЗОНЕ");
  const outRange = positions.filter((p) => p.status !== "В ДИАПАЗОНЕ");
  const totalValue = positions.reduce((s, p) => s + (p.valueUSD || 0), 0);

  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          fontWeight: 700,
          fontSize: 15,
          marginBottom: 12,
          color: "#a78bfa",
        }}
      >
        💡 РАЗДЕЛ 4: РЕКОМЕНДАЦИИ ПО ОПТИМИЗАЦИИ
      </div>

      <div
        style={{
          background: "#1e293b",
          borderRadius: 8,
          padding: "16px",
          marginBottom: 12,
          border: "1px solid #334155",
        }}
      >
        <div style={{ fontWeight: 600, color: "#7dd3fc", marginBottom: 8 }}>
          4.1 Анализ текущих пулов
        </div>
        {positions.map((pos) => (
          <div
            key={pos.id}
            style={{
              marginBottom: 8,
              padding: "8px",
              background: "#0f172a",
              borderRadius: 6,
            }}
          >
            <span style={{ color: "#a78bfa", fontWeight: 600 }}>{pos.id}</span>
            <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
              {pos.version === "V3" && (
                <>
                  • Версия V3 оптимальна для активного управления. Для WETH/USDC
                  при умеренной волатильности — рекомендую рассмотреть V4 с
                  hooks для автоматической ребалансировки.
                  <br />• Комиссия {pos.fee}%:{" "}
                  {pos.fee === "0.05"
                    ? "✅ Оптимально для стейблкоин-пар с низкой волатильностью"
                    : pos.fee === "0.3"
                      ? "✅ Стандартная комиссия, подходит для WETH/USDC"
                      : "⚠️ Высокая комиссия — уместна только при высокой волатильности"}
                </>
              )}
              {pos.version === "V4" && (
                <>
                  • Версия V4 — отличный выбор. Используйте hooks для
                  динамических комиссий и автоматического ребалансирования.
                  <br />• Комиссия {pos.fee}%: проверьте, настроен ли
                  динамический fee через hook-контракт.
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          background: "#1e293b",
          borderRadius: 8,
          padding: "16px",
          marginBottom: 12,
          border: "1px solid #334155",
        }}
      >
        <div style={{ fontWeight: 600, color: "#7dd3fc", marginBottom: 8 }}>
          4.2 Рекомендации по улучшению
        </div>
        {outRange.length > 0 && (
          <div
            style={{
              padding: "8px",
              background: "#2d1b1b",
              borderRadius: 6,
              marginBottom: 8,
              borderLeft: "3px solid #f59e0b",
            }}
          >
            <span style={{ color: "#f59e0b", fontWeight: 600 }}>
              ⚠️ {outRange.length} позиция вне диапазона
            </span>
            <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
              {outRange.map((p) => `${p.id} (${p.pool})`).join(", ")} —
              необходима ребалансировка. Рекомендую расширить диапазон ±15-20%
              от текущей цены или переместить позицию.
            </div>
          </div>
        )}
        {inRange.length > 0 && (
          <div
            style={{
              padding: "8px",
              background: "#1a2d1a",
              borderRadius: 6,
              borderLeft: "3px solid #22c55e",
            }}
          >
            <span style={{ color: "#22c55e", fontWeight: 600 }}>
              ✅ {inRange.length} позиция в диапазоне
            </span>
            <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
              Следите за тем, чтобы диапазон оставался актуальным. При выходе
              цены за границы — оперативно корректируйте.
            </div>
          </div>
        )}
      </div>

      <div
        style={{
          background: "#1e293b",
          borderRadius: 8,
          padding: "16px",
          marginBottom: 12,
          border: "1px solid #334155",
        }}
      >
        <div style={{ fontWeight: 600, color: "#7dd3fc", marginBottom: 8 }}>
          4.3 Общая стратегия V3 vs V4
        </div>
        <div style={{ color: "#94a3b8", fontSize: 12, lineHeight: 1.8 }}>
          🔵 <strong style={{ color: "#e2e8f0" }}>Оставить в V3:</strong>{" "}
          Стабильные позиции с широкими диапазонами, не требующие частой
          ребалансировки. WETH/USDC с диапазоном ±30%.
          <br />
          🟣 <strong style={{ color: "#e2e8f0" }}>Перенести в V4:</strong>{" "}
          Активно управляемые позиции, особенно при узких диапазонах — V4
          значительно дешевле по газу (до 99% экономии).
          <br />⚡{" "}
          <strong style={{ color: "#e2e8f0" }}>
            Динамическая комиссия V4:
          </strong>{" "}
          Рекомендуется использовать hook с dynamic fees для пар с высокой
          волатильностью. Это позволит автоматически увеличивать комиссию в
          периоды волатильности и снижать в спокойные периоды.
        </div>
      </div>

      <div
        style={{
          background: "#1e293b",
          borderRadius: 8,
          padding: "16px",
          border: "1px solid #334155",
        }}
      >
        <div style={{ fontWeight: 600, color: "#7dd3fc", marginBottom: 8 }}>
          🤖 РАЗДЕЛ 5: ПОДГОТОВКА К АВТОМАТИЗАЦИИ
        </div>
        <div style={{ marginBottom: 8 }}>
          <div
            style={{
              color: "#f59e0b",
              fontWeight: 600,
              fontSize: 12,
              marginBottom: 6,
            }}
          >
            Кандидаты для автоматизации:
          </div>
          {outRange.length > 0 ? (
            outRange.map((p) => (
              <div
                key={p.id}
                style={{
                  padding: "6px 8px",
                  background: "#0f172a",
                  borderRadius: 4,
                  marginBottom: 4,
                  fontSize: 12,
                }}
              >
                <span style={{ color: "#a78bfa" }}>{p.id}</span>
                <span style={{ color: "#94a3b8", marginLeft: 8 }}>
                  → Реализовать автоматическую ребалансировку при выходе из
                  диапазона
                </span>
              </div>
            ))
          ) : (
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              Все позиции в диапазоне. При следующем отчёте проверьте снова.
            </div>
          )}
        </div>
        <div>
          <div
            style={{
              color: "#f59e0b",
              fontWeight: 600,
              fontSize: 12,
              marginBottom: 6,
            }}
          >
            Рекомендуемая логика бота:
          </div>
          <div
            style={{
              color: "#94a3b8",
              fontSize: 12,
              lineHeight: 1.8,
              padding: "8px",
              background: "#0f172a",
              borderRadius: 4,
            }}
          >
            1. <strong style={{ color: "#e2e8f0" }}>Триггер:</strong> Цена
            выходит за пределы диапазона → сбор комиссий → закрытие позиции
            <br />
            2. <strong style={{ color: "#e2e8f0" }}>
              Новый диапазон:
            </strong>{" "}
            Центрировать ±10% вокруг текущей цены (узкий) или ±20% (умеренный)
            <br />
            3. <strong style={{ color: "#e2e8f0" }}>Оптимизация:</strong> Для V4
            использовать PoolManager напрямую (экономия газа ~70%)
            <br />
            4. <strong style={{ color: "#e2e8f0" }}>Мониторинг:</strong> Алерты
            при достижении 80% и 95% ширины диапазона
          </div>
        </div>
      </div>
    </div>
  );
}

function AlertsPanel({ alerts, setAlerts, positions, ethPrice }) {
  const [alertInput, setAlertInput] = useState({
    asset: "ETH",
    lower: "",
    upper: "",
  });
  const addAlert = () => {
    if (!alertInput.lower || !alertInput.upper) return;
    setAlerts((prev) => [
      ...prev,
      {
        id: Date.now(),
        asset: alertInput.asset,
        lower: parseFloat(alertInput.lower),
        upper: parseFloat(alertInput.upper),
        triggered: false,
      },
    ]);
    setAlertInput({ asset: "ETH", lower: "", upper: "" });
  };

  const currentPrice = ethPrice;
  const triggeredAlerts = alerts.filter(
    (a) => currentPrice < a.lower || currentPrice > a.upper,
  );

  return (
    <div
      style={{
        background: "#1e293b",
        borderRadius: 8,
        padding: "16px",
        marginBottom: 16,
        border: "1px solid #334155",
      }}
    >
      <div
        style={{
          fontWeight: 700,
          fontSize: 14,
          marginBottom: 12,
          color: "#f59e0b",
        }}
      >
        🔔 СИСТЕМА АЛЕРТОВ
      </div>
      {triggeredAlerts.length > 0 && (
        <div
          style={{
            background: "#2d1b00",
            border: "2px solid #f59e0b",
            borderRadius: 6,
            padding: "10px",
            marginBottom: 12,
          }}
        >
          {triggeredAlerts.map((a) => (
            <div key={a.id} style={{ color: "#fbbf24", fontWeight: 600 }}>
              ⚠️ АЛЕРТ: {a.asset} (${currentPrice.toFixed(0)}) вышел за диапазон
              ${a.lower}–${a.upper}!
            </div>
          ))}
        </div>
      )}
      <div
        style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
      >
        <input
          value={alertInput.asset}
          onChange={(e) =>
            setAlertInput((p) => ({ ...p, asset: e.target.value }))
          }
          style={{
            background: "#0f172a",
            border: "1px solid #334155",
            color: "#e2e8f0",
            padding: "6px 10px",
            borderRadius: 4,
            width: 80,
          }}
          placeholder="ETH"
        />
        <input
          value={alertInput.lower}
          onChange={(e) =>
            setAlertInput((p) => ({ ...p, lower: e.target.value }))
          }
          style={{
            background: "#0f172a",
            border: "1px solid #334155",
            color: "#e2e8f0",
            padding: "6px 10px",
            borderRadius: 4,
            width: 100,
          }}
          placeholder="Нижняя $"
          type="number"
        />
        <input
          value={alertInput.upper}
          onChange={(e) =>
            setAlertInput((p) => ({ ...p, upper: e.target.value }))
          }
          style={{
            background: "#0f172a",
            border: "1px solid #334155",
            color: "#e2e8f0",
            padding: "6px 10px",
            borderRadius: 4,
            width: 100,
          }}
          placeholder="Верхняя $"
          type="number"
        />
        <button
          onClick={addAlert}
          style={{
            background: "#7c3aed",
            color: "white",
            border: "none",
            padding: "6px 14px",
            borderRadius: 4,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          + Добавить алерт
        </button>
      </div>
      {alerts.length === 0 && (
        <div style={{ color: "#64748b", fontSize: 12 }}>
          Алерты не настроены. Добавьте ценовые уровни выше.
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {alerts.map((a) => {
          const triggered = currentPrice < a.lower || currentPrice > a.upper;
          return (
            <div
              key={a.id}
              style={{
                background: triggered ? "#2d1b00" : "#0f172a",
                border: `1px solid ${triggered ? "#f59e0b" : "#334155"}`,
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ color: triggered ? "#fbbf24" : "#94a3b8" }}>
                {triggered ? "⚠️" : "✓"} {a.asset}: ${a.lower}–${a.upper}
              </span>
              <button
                onClick={() =>
                  setAlerts((prev) => prev.filter((x) => x.id !== a.id))
                }
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#64748b",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: 12,
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function App() {
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ethPrice, setEthPrice] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [rawData, setRawData] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  const fetchPositions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch ETH price in parallel
      const [ethPriceVal, subgraphData] = await Promise.all([
        fetchETHPrice(),
        fetchSubgraph(POSITIONS_QUERY, { owner: WALLET.toLowerCase() }),
      ]);

      setEthPrice(ethPriceVal);

      if (!subgraphData?.positions) {
        // Try to get all positions (including closed)
        const allData = await fetchSubgraph(ALL_POSITIONS_QUERY, {
          owner: WALLET.toLowerCase(),
        });
        if (!allData?.positions?.length) {
          setError(
            "Субграф не вернул данные. Возможно, на данном кошельке нет активных V3 позиций на Base, или субграф временно недоступен.",
          );
          setPositions([]);
          setLoading(false);
          return;
        }
        setRawData(allData);
      } else {
        setRawData(subgraphData);
      }

      const raw = subgraphData?.positions || [];
      setRawData(raw);

      const processed = raw
        .map((pos) => {
          const dec0 = parseInt(pos.token0.decimals);
          const dec1 = parseInt(pos.token1.decimals);
          const sqrtPrice = pos.pool.sqrtPrice;
          const tick = parseInt(pos.pool.tick);
          const tickLower = parseInt(pos.tickLower.tickIdx);
          const tickUpper = parseInt(pos.tickUpper.tickIdx);

          const sqrtLower = Math.pow(1.0001, tickLower);
          const sqrtUpper = Math.pow(1.0001, tickUpper);
          const sqrtCurrent = Math.pow(1.0001, tick);

          const { amount0, amount1 } = calcTokenAmounts(
            pos.liquidity,
            BigInt(sqrtPrice),
            sqrtLower,
            sqrtUpper,
          );

          // Prices: token1 per token0 (adjusted for decimals)
          const rawCurrentPrice = sqrtPriceX96ToPrice(sqrtPrice, dec0, dec1);
          const sym0 = pos.token0.symbol;
          const sym1 = pos.token1.symbol;

          let currentUSD, lowerUSD, upperUSD, a0, a1;

          if (sym0 === "WETH" || sym0 === "ETH") {
            // price is token1/token0 = USDC per WETH
            currentUSD = rawCurrentPrice;
            lowerUSD = sqrtPriceX96ToPrice(
              BigInt(
                Math.round(
                  Math.pow(Math.sqrt(sqrtLower), 2) * Math.pow(2, 192),
                ),
              ).toString(),
              dec0,
              dec1,
            );
            // Simple tick-based price
            lowerUSD = Math.pow(1.0001, tickLower) * Math.pow(10, dec0 - dec1);
            upperUSD = Math.pow(1.0001, tickUpper) * Math.pow(10, dec0 - dec1);
            currentUSD = Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
            a0 = amount0 / Math.pow(10, dec0); // WETH
            a1 = amount1 / Math.pow(10, dec1); // USDC
          } else if (sym1 === "WETH" || sym1 === "ETH") {
            // USDC/WETH pool, price is WETH per USDC
            const rawP = Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
            currentUSD = rawP > 0 ? 1 / rawP : ethPriceVal;
            lowerUSD =
              1 / (Math.pow(1.0001, tickUpper) * Math.pow(10, dec0 - dec1));
            upperUSD =
              1 / (Math.pow(1.0001, tickLower) * Math.pow(10, dec0 - dec1));
            a0 = amount1 / Math.pow(10, dec1); // ETH amount
            a1 = amount0 / Math.pow(10, dec0); // USDC amount
          } else {
            currentUSD = parseFloat(pos.pool.token0Price) || 0;
            lowerUSD = parseFloat(pos.tickLower.price0) || 0;
            upperUSD = parseFloat(pos.tickUpper.price0) || 0;
            a0 =
              parseFloat(pos.depositedToken0) - parseFloat(pos.withdrawnToken0);
            a1 =
              parseFloat(pos.depositedToken1) - parseFloat(pos.withdrawnToken1);
          }

          const inRange = currentUSD >= lowerUSD && currentUSD <= upperUSD;
          const valueUSD = a0 * currentUSD + a1;

          const feePercent = (pos.pool.feeTier / 10000).toFixed(2);
          const pool = `${sym0}/${sym1}`;
          const posId = `POS-${pos.id.slice(0, 8)}`;

          return {
            id: posId,
            rawId: pos.id,
            pool,
            version: "V3",
            fee: feePercent,
            lowerUSD: parseFloat(lowerUSD.toFixed(2)),
            upperUSD: parseFloat(upperUSD.toFixed(2)),
            currentUSD: parseFloat(currentUSD.toFixed(2)),
            status: inRange ? "В ДИАПАЗОНЕ" : "ВНЕ ДИАПАЗОНА",
            amount0: parseFloat(a0.toFixed(6)),
            amount1: parseFloat(a1.toFixed(2)),
            valueUSD: parseFloat(valueUSD.toFixed(2)),
            token0: pos.token0,
            token1: pos.token1,
          };
        })
        .sort((a, b) => b.upperUSD - a.upperUSD);

      setPositions(processed);
      setLastUpdated(new Date());
    } catch (e) {
      setError(`Ошибка получения данных: ${e.message}`);
    }
    setLoading(false);
  }, []);

  const totalValue = positions.reduce((s, p) => s + (p.valueUSD || 0), 0);
  const inRangeCount = positions.filter(
    (p) => p.status === "В ДИАПАЗОНЕ",
  ).length;

  return (
    <div
      style={{
        background: "#0b1120",
        minHeight: "100vh",
        color: "#e2e8f0",
        fontFamily: "'Segoe UI',system-ui,sans-serif",
        padding: "0 0 40px",
      }}
    >
      {/* Header */}
      <div
        style={{
          background: "linear-gradient(135deg,#1e1b4b,#0f172a)",
          padding: "20px 24px",
          borderBottom: "1px solid #334155",
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 28 }}>🦄</span>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#a78bfa" }}>
                DeFi LP Аналитик
              </div>
              <div style={{ fontSize: 11, color: "#64748b" }}>
                Uniswap V3/V4 · Base Network · Real-time
              </div>
            </div>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#475569",
              fontFamily: "monospace",
              marginTop: 4,
            }}
          >
            👛 {WALLET}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 16px" }}>
        {/* Controls */}
        <div
          style={{
            display: "flex",
            gap: 12,
            marginBottom: 20,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={fetchPositions}
            disabled={loading}
            style={{
              background: loading
                ? "#374151"
                : "linear-gradient(135deg,#7c3aed,#4f46e5)",
              color: "white",
              border: "none",
              padding: "10px 24px",
              borderRadius: 8,
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 700,
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {loading ? "⏳ Загружаем..." : "🔄 ОТЧЁТ / АНАЛИЗ"}
          </button>
          {lastUpdated && (
            <span style={{ color: "#64748b", fontSize: 12 }}>
              Обновлено: {lastUpdated.toLocaleTimeString("ru-RU")}
            </span>
          )}
          {ethPrice > 0 && (
            <span style={{ color: "#60a5fa", fontWeight: 600, fontSize: 13 }}>
              ETH: ${ethPrice.toFixed(2)}
            </span>
          )}
        </div>

        {/* Alerts */}
        <AlertsPanel
          alerts={alerts}
          setAlerts={setAlerts}
          positions={positions}
          ethPrice={ethPrice}
        />

        {/* Summary */}
        {positions.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))",
              gap: 12,
              marginBottom: 20,
            }}
          >
            {[
              {
                label: "Позиций",
                value: positions.length,
                color: "#a78bfa",
                icon: "📊",
              },
              {
                label: "В диапазоне",
                value: `${inRangeCount}/${positions.length}`,
                color: "#22c55e",
                icon: "✅",
              },
              {
                label: "Общая стоимость",
                value: `$${Math.round(totalValue).toLocaleString()}`,
                color: "#60a5fa",
                icon: "💰",
              },
              {
                label: "ETH цена",
                value: `$${ethPrice.toFixed(0)}`,
                color: "#fbbf24",
                icon: "⚡",
              },
            ].map((s) => (
              <div
                key={s.label}
                style={{
                  background: "#1e293b",
                  borderRadius: 8,
                  padding: "14px",
                  border: "1px solid #334155",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 20 }}>{s.icon}</div>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    color: s.color,
                    marginTop: 4,
                  }}
                >
                  {s.value}
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div
            style={{
              background: "#1a1010",
              border: "1px solid #ef4444",
              borderRadius: 8,
              padding: "16px",
              marginBottom: 16,
              color: "#fca5a5",
              fontSize: 13,
            }}
          >
            <strong>⚠️ Внимание:</strong> {error}
            <div style={{ marginTop: 8, color: "#94a3b8", fontSize: 12 }}>
              💡 Для ручной проверки используйте:{" "}
              <a
                href={`https://revert.finance/#/account/${WALLET}?chainId=8453`}
                target="_blank"
                rel="noopener"
                style={{ color: "#60a5fa" }}
              >
                revert.finance
              </a>{" "}
              или{" "}
              <a
                href={`https://app.uniswap.org/positions`}
                target="_blank"
                rel="noopener"
                style={{ color: "#60a5fa" }}
              >
                app.uniswap.org
              </a>
            </div>
          </div>
        )}

        {/* Table */}
        <div
          style={{
            background: "#1e293b",
            borderRadius: 10,
            padding: "16px",
            marginBottom: 16,
            border: "1px solid #334155",
          }}
        >
          <div
            style={{
              fontWeight: 700,
              fontSize: 15,
              marginBottom: 12,
              color: "#a78bfa",
            }}
          >
            📋 РАЗДЕЛ 1-3: ТАБЛИЦА LP-ПОЗИЦИЙ
          </div>
          <ReportTable
            positions={positions}
            ethPrice={ethPrice}
            loading={loading}
          />
        </div>

        {/* ASCII Chart */}
        {positions.length > 0 && (
          <div
            style={{
              background: "#1e293b",
              borderRadius: 10,
              padding: "16px",
              marginBottom: 16,
              border: "1px solid #334155",
            }}
          >
            <ASCIIChart positions={positions} ethPrice={ethPrice} />
          </div>
        )}

        {/* Recommendations */}
        {positions.length > 0 && (
          <div
            style={{
              background: "#1e293b",
              borderRadius: 10,
              padding: "16px",
              border: "1px solid #334155",
            }}
          >
            <Recommendations positions={positions} />
          </div>
        )}

        {/* Fallback links */}
        {!loading && positions.length === 0 && !error && (
          <div
            style={{
              background: "#1e293b",
              borderRadius: 8,
              padding: "16px",
              border: "1px solid #334155",
              textAlign: "center",
            }}
          >
            <div style={{ color: "#94a3b8", marginBottom: 12 }}>
              Нажмите "ОТЧЁТ / АНАЛИЗ" чтобы загрузить данные
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              {[
                {
                  label: "🌐 Revert Finance",
                  url: `https://revert.finance/#/account/${WALLET}?chainId=8453`,
                },
                {
                  label: "🦄 Uniswap App",
                  url: "https://app.uniswap.org/positions",
                },
                {
                  label: "🔍 BaseScan",
                  url: `https://basescan.org/address/${WALLET}`,
                },
              ].map((l) => (
                <a
                  key={l.label}
                  href={l.url}
                  target="_blank"
                  rel="noopener"
                  style={{
                    background: "#0f172a",
                    color: "#60a5fa",
                    padding: "8px 14px",
                    borderRadius: 6,
                    textDecoration: "none",
                    fontSize: 12,
                    border: "1px solid #334155",
                  }}
                >
                  {l.label}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
