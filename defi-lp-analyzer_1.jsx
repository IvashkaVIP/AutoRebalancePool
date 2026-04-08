const { useState, useCallback } = React;

const DEFAULT_WALLET = "0x26f24bcadb806ea9287fa68883a3a4f775024f34";
const CHAIN_ID = 8453;
const BASE_RPC_PROXY = "/rpc";
const POSITION_MANAGER_ADDRESS = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";
const UNISWAP_FACTORY_ADDRESS = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";

const POSITION_MANAGER_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
];
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const provider = new ethers.providers.JsonRpcProvider(BASE_RPC_PROXY, CHAIN_ID);
const MULTICALL_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";
const tokenInfoCache = {};

async function getTokenInfo(address) {
  const key = address.toLowerCase();
  if (tokenInfoCache[key]) return tokenInfoCache[key];

  const token = new ethers.Contract(address, ERC20_ABI, provider);
  try {
    const symbol = await token.symbol();
    const decimals = await token.decimals();
    const info = { id: address, symbol, decimals: Number(decimals) };
    tokenInfoCache[key] = info;
    return info;
  } catch (error) {
    console.warn('Не удалось получить токен:', address, error);
    return { id: address, symbol: 'UNKNOWN', decimals: 18 };
  }
}

function tickToPrice(tick) {
  return Math.pow(1.0001, tick);
}

function getSqrtPriceFromTick(tick) {
  return Math.pow(1.0001, tick / 2);
}

function calcAmountsForPosition(liquidity, currentSqrt, sqrtLower, sqrtUpper) {
  const L = Number(ethers.utils.formatUnits(liquidity, 0));
  const sa = sqrtLower;
  const sb = sqrtUpper;
  let amount0 = 0;
  let amount1 = 0;

  if (currentSqrt <= sa) {
    amount0 = L * (sb - sa) / (sa * sb);
  } else if (currentSqrt >= sb) {
    amount1 = L * (sb - sa);
  } else {
    amount0 = L * (sb - currentSqrt) / (currentSqrt * sb);
    amount1 = L * (currentSqrt - sa);
  }

  return { amount0, amount1 };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPositionsFromChain(owner) {
  const positionManagerInterface = new ethers.utils.Interface(POSITION_MANAGER_ABI);
  const factoryInterface = new ethers.utils.Interface(FACTORY_ABI);
  const erc20Interface = new ethers.utils.Interface(ERC20_ABI);
  const poolInterface = new ethers.utils.Interface(POOL_ABI);
  const multicall = new ethers.Contract(
    MULTICALL_ADDRESS,
    [
      'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
      'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
    ],
    provider,
  );

  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);
  const balanceBN = await positionManager.balanceOf(owner);
  const count = balanceBN.toNumber();
  if (count === 0) return [];

  const maxPositions = 6;
  const indexCalls = [];
  for (let index = 0; index < Math.min(count, maxPositions); index += 1) {
    indexCalls.push({
      target: POSITION_MANAGER_ADDRESS,
      callData: positionManagerInterface.encodeFunctionData('tokenOfOwnerByIndex', [owner, index]),
    });
  }

  const [, indexResults] = await multicall.aggregate(indexCalls);
  const tokenIds = indexResults.map((data) => positionManagerInterface.decodeFunctionResult('tokenOfOwnerByIndex', data)[0]);
  if (!tokenIds.length) return [];

  const positionCalls = tokenIds.map((tokenId) => ({
    target: POSITION_MANAGER_ADDRESS,
    callData: positionManagerInterface.encodeFunctionData('positions', [tokenId]),
  }));

  const [, positionResults] = await multicall.aggregate(positionCalls);
  const rawPositions = positionResults.map((data, idx) => {
    try {
      return positionManagerInterface.decodeFunctionResult('positions', data);
    } catch (error) {
      console.warn('decode positions failed', tokenIds[idx].toString(), error);
      return null;
    }
  }).filter(Boolean);
  if (!rawPositions.length) return [];

  const infoCalls = [];
  rawPositions.forEach((pos) => {
    infoCalls.push({ target: pos.token0, callData: erc20Interface.encodeFunctionData('symbol', []) });
    infoCalls.push({ target: pos.token0, callData: erc20Interface.encodeFunctionData('decimals', []) });
    infoCalls.push({ target: pos.token1, callData: erc20Interface.encodeFunctionData('symbol', []) });
    infoCalls.push({ target: pos.token1, callData: erc20Interface.encodeFunctionData('decimals', []) });
    infoCalls.push({ target: UNISWAP_FACTORY_ADDRESS, callData: factoryInterface.encodeFunctionData('getPool', [pos.token0, pos.token1, pos.fee]) });
  });

  const infoResponses = await multicall.tryAggregate(false, infoCalls);
  const infoResults = infoResponses.map((response) => response.returnData);
  const positions = [];
  for (let i = 0; i < rawPositions.length; i += 1) {
    const pos = rawPositions[i];
    const base = i * 5;
    try {
      const token0Symbol = erc20Interface.decodeFunctionResult('symbol', infoResults[base])[0];
      const token0Decimals = erc20Interface.decodeFunctionResult('decimals', infoResults[base + 1])[0];
      const token1Symbol = erc20Interface.decodeFunctionResult('symbol', infoResults[base + 2])[0];
      const token1Decimals = erc20Interface.decodeFunctionResult('decimals', infoResults[base + 3])[0];
      const poolAddress = factoryInterface.decodeFunctionResult('getPool', infoResults[base + 4])[0];

      if (!poolAddress || poolAddress === ethers.constants.AddressZero) continue;
      positions.push({
        tokenId: tokenIds[i],
        token0Symbol,
        token0Decimals: Number(token0Decimals),
        token1Symbol,
        token1Decimals: Number(token1Decimals),
        poolAddress,
        pos,
      });
    } catch (error) {
      console.warn('decode position info failed', i, error);
    }
  }
  if (!positions.length) return [];

  const slotCalls = positions.map((item) => ({
    target: item.poolAddress,
    callData: poolInterface.encodeFunctionData('slot0', []),
  }));
  const slotResponses = await multicall.tryAggregate(false, slotCalls);
  const slotResults = slotResponses.map((response) => response.returnData);

  return positions.map((item, idx) => {
    const slot0 = poolInterface.decodeFunctionResult('slot0', slotResults[idx]);
    const currentSqrt = Number(ethers.utils.formatUnits(slot0.sqrtPriceX96, 96));
    const lowerPrice = tickToPrice(item.pos.tickLower) * Math.pow(10, item.token0Decimals - item.token1Decimals);
    const upperPrice = tickToPrice(item.pos.tickUpper) * Math.pow(10, item.token0Decimals - item.token1Decimals);
    const currentPrice = currentSqrt * currentSqrt * Math.pow(10, item.token0Decimals - item.token1Decimals);
    const { amount0, amount1 } = calcAmountsForPosition(item.pos.liquidity, currentSqrt, getSqrtPriceFromTick(item.pos.tickLower), getSqrtPriceFromTick(item.pos.tickUpper));
    const amount0norm = amount0 / Math.pow(10, item.token0Decimals);
    const amount1norm = amount1 / Math.pow(10, item.token1Decimals);
    return {
      id: item.tokenId.toString(),
      pool: `${item.token0Symbol}/${item.token1Symbol}`,
      fee: Number(item.pos.fee) / 10000,
      lowerUSD: Number(lowerPrice.toFixed(4)),
      upperUSD: Number(upperPrice.toFixed(4)),
      currentUSD: Number(currentPrice.toFixed(4)),
      status: currentPrice >= lowerPrice && currentPrice <= upperPrice ? 'В ДИАПАЗОНЕ' : 'ВНЕ ДИАПАЗОНА',
      amount0: Number(amount0norm.toFixed(4)),
      amount1: Number(amount1norm.toFixed(4)),
      valueUSD: Number((amount1norm * currentPrice + amount0norm).toFixed(2)),
    };
  });
}

async function fetchETHPrice() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await response.json();
    return data?.ethereum?.usd || 1900;
  } catch (error) {
    console.warn('Ошибка Coingecko', error);
    return 1900;
  }
}

function StatusBadge({ status }) {
  return status === 'В ДИАПАЗОНЕ' ? (
    <span style={{ color: '#22c55e', fontWeight: 700 }}>В ДИАПАЗОНЕ ✅</span>
  ) : (
    <span style={{ color: '#f59e0b', fontWeight: 700 }}>ВНЕ ДИАПАЗОНА ⚠️</span>
  );
}

function ASCIIChart({ positions, ethPrice }) {
  if (!positions.length) return null;
  const minPrice = Math.min(...positions.map((pos) => pos.lowerUSD));
  const maxPrice = Math.max(...positions.map((pos) => pos.upperUSD));
  const range = maxPrice - minPrice || 1;
  const width = 60;
  const current = positions[0]?.currentUSD || ethPrice;

  const lines = positions.map((pos) => {
    const left = Math.round(((pos.lowerUSD - minPrice) / range) * width);
    const right = Math.round(((pos.upperUSD - minPrice) / range) * width);
    const bar = ' '.repeat(left) + '█'.repeat(Math.max(1, right - left));
    return `│ ${bar.padEnd(width, ' ')} │ ${pos.pool} $${Math.round(pos.valueUSD)}`;
  });
  const currentX = Math.max(0, Math.min(width, Math.round(((current - minPrice) / range) * width)));
  const priceLine = `│ ${' '.repeat(currentX)}▼${' '.repeat(Math.max(0, width - currentX))} │`;

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8, color: '#a78bfa' }}>📊 ВИЗУАЛИЗАЦИЯ ЛИКВИДНОСТИ</div>
      <pre style={{ background: '#0f172a', color: '#e2e8f0', padding: '12px 16px', borderRadius: 8, fontSize: 12, overflowX: 'auto', border: '1px solid #334155' }}>
        {`  ▼ ТЕКУЩАЯ ЦЕНА: $${Math.round(current)}\n${['┌' + '─'.repeat(width + 2) + '┐', ...lines, priceLine, '└' + '─'.repeat(width + 2) + '┘'].join('\n')}`}
      </pre>
    </div>
  );
}

function ReportTable({ positions, loading }) {
  if (loading) return <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>⏳ Загружаем данные...</div>;
  if (!positions.length) return <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>🔍 Активные LP-позиции не найдены.</div>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#1e293b', color: '#94a3b8' }}>
            {['ID', 'Пул', 'Комиссия', 'Нижняя $', 'Верхняя $', 'Текущая $', 'Статус', 'Token0', 'Token1', 'USD'].map((h) => (
              <th key={h} style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #334155' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.map((pos, index) => (
            <tr key={pos.id} style={{ background: index % 2 === 0 ? '#0f172a' : '#1a2332', borderBottom: '1px solid #1e293b' }}>
              <td style={{ padding: '7px 10px', color: '#7dd3fc' }}>{pos.id}</td>
              <td style={{ padding: '7px 10px', fontWeight: 600 }}>{pos.pool}</td>
              <td style={{ padding: '7px 10px', color: '#34d399' }}>{pos.fee}%</td>
              <td style={{ padding: '7px 10px', color: '#fbbf24' }}>${pos.lowerUSD}</td>
              <td style={{ padding: '7px 10px', color: '#fbbf24' }}>${pos.upperUSD}</td>
              <td style={{ padding: '7px 10px', color: '#60a5fa' }}>${pos.currentUSD}</td>
              <td style={{ padding: '7px 10px' }}><StatusBadge status={pos.status} /></td>
              <td style={{ padding: '7px 10px' }}>{pos.amount0}</td>
              <td style={{ padding: '7px 10px' }}>{pos.amount1}</td>
              <td style={{ padding: '7px 10px', fontWeight: 700, color: '#22c55e' }}>${Math.round(pos.valueUSD)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Recommendations({ positions }) {
  if (!positions.length) return null;
  const outOfRange = positions.filter((pos) => pos.status !== 'В ДИАПАЗОНЕ');

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: '#a78bfa' }}>💡 РЕКОМЕНДАЦИИ</div>
      <div style={{ background: '#1e293b', borderRadius: 8, padding: '16px', border: '1px solid #334155' }}>
        {outOfRange.length > 0 ? (
          <div style={{ color: '#f59e0b' }}>⚠️ {outOfRange.length} позиций вне диапазона. Рассмотрите ребаланс.</div>
        ) : (
          <div style={{ color: '#22c55e' }}>✅ Все позиции в диапазоне. Активных действий не требуется.</div>
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
    setError(null);
    if (!wallet || !wallet.startsWith('0x') || wallet.length !== 42) {
      setError('Неверный адрес');
      return;
    }

    setLoading(true);
    try {
      const [price, chainPositions] = await Promise.all([fetchETHPrice(), fetchPositionsFromChain(wallet.toLowerCase())]);
      setEthPrice(price);
      setPositions(chainPositions);
      if (!chainPositions.length) {
        setError('Активные LP-позиции не найдены.');
      }
    } catch (err) {
      console.error('fetchPositions error', err);
      setError(err.message || 'Ошибка при загрузке позиций');
      setPositions([]);
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  return (
    <div style={{ background: '#0b1120', minHeight: '100vh', color: '#e2e8f0', fontFamily: 'sans-serif', padding: '20px' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ marginBottom: 20, display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            style={{ flex: 1, background: '#1e293b', border: '1px solid #334155', color: 'white', padding: '10px', borderRadius: 8 }}
            placeholder='Введите адрес кошелька (0x...)'
          />
          <button
            onClick={fetchPositions}
            disabled={loading}
            style={{ background: '#7c3aed', color: 'white', border: 'none', padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}
          >
            {loading ? '⌛ Загрузка' : 'АНАЛИЗ'}
          </button>
        </div>

        {error && <div style={{ color: '#ef4444', marginBottom: 10 }}>⚠️ {error}</div>}
        <div style={{ background: '#1e293b', borderRadius: 10, padding: '16px', border: '1px solid #334155' }}>
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
