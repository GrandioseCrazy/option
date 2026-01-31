const { createApp, reactive, ref, computed, onMounted, watch } = Vue;
const math = window.math;

const CONTRACT_SIZE = 100;

const app = {
  setup() {
    const state = reactive({
      symbol: 'SMCI',
      loading: false,
      error: '',
      rawData: null,
      options: [],
      filterType: 'ALL',
      filterExpiry: 'ALL',
      underlying: { symbol: '', price: null },
      selected: null,
      inputs: {
        spot: null,
        volatilityPct: null,
        riskFreePct: 3,
        dividendPct: 0
      },
      position: 'SELL',
      activeTab: 'strategy',
      strategy: {
        type: 'covered_call'
      },
      alertPrice: null,
      alerts: [],
      history: {
        loading: false,
        error: '',
        data: []
      },
      pagination: {
        page: 1,
        pageSize: 10,
        pageSizes: [10, 20, 50, 100]
      }
    });

    const historyChartEl = ref(null);
    let historyChart;

    const fetchChain = async () => {
      const symbol = state.symbol.trim().toUpperCase();
      if (!symbol) {
        state.error = '请输入股票代码';
        return;
      }

      fetchHistory(symbol);
      state.loading = true;
      state.error = '';
      try {
        const response = await fetch(`/api/option/chain/${encodeURIComponent(symbol)}`);
        if (!response.ok) {
          throw new Error(`API请求失败: ${response.status}`);
        }
        const data = await response.json();
        state.rawData = data;
        const normalized = normalizeChain(data);
        state.options = normalized;
        state.underlying = extractUnderlying(data, normalized, symbol);
        state.symbol = symbol;
        state.filterExpiry = 'ALL';
        state.pagination.page = 1;
        if (state.underlying.price) {
          state.inputs.spot = round(state.underlying.price, 4);
        }
        if (!state.inputs.volatilityPct && normalized[0]?.ivPct) {
          state.inputs.volatilityPct = normalized[0].ivPct;
        }
        if (normalized.length) {
          state.selected = normalized[0];
        }
      } catch (error) {
        state.error = error.message;
      } finally {
        state.loading = false;
      }
    };

    const fetchHistory = async (symbol) => {
      state.history.loading = true;
      state.history.error = '';
      try {
        const response = await fetch(`/api/stock/history/${encodeURIComponent(symbol)}`);
        if (!response.ok) {
          throw new Error(`行情请求失败: ${response.status}`);
        }
        const payload = await response.json();
        state.history.data = Array.isArray(payload.data) ? payload.data : [];
      } catch (error) {
        state.history.error = error.message;
        state.history.data = [];
      } finally {
        state.history.loading = false;
        scheduleChartUpdate();
      }
    };

    const expiryOptions = computed(() => {
      const set = new Set();
      state.options.forEach((option) => {
        if (option.expiry) {
          set.add(option.expiry);
        }
      });
      return Array.from(set).sort();
    });

    const filteredOptions = computed(() => {
      const list = state.options.filter((option) => {
        const typeOk = state.filterType === 'ALL' || option.type === state.filterType;
        const expiryOk = state.filterExpiry === 'ALL' || option.expiry === state.filterExpiry;
        return typeOk && expiryOk;
      });
      list.sort((a, b) => {
        const strikeA = toNumber(a.strike) ?? 0;
        const strikeB = toNumber(b.strike) ?? 0;
        if (strikeA !== strikeB) return strikeB - strikeA;
        const expiryA = a.expiry || '';
        const expiryB = b.expiry || '';
        return expiryA.localeCompare(expiryB);
      });
      return list;
    });

    const pagedOptions = computed(() => {
      const page = state.pagination.page;
      const size = state.pagination.pageSize;
      const start = (page - 1) * size;
      return filteredOptions.value.slice(start, start + size);
    });

    const selectedInputs = computed(() => {
      if (!state.selected) return null;
      const spot = toNumber(state.inputs.spot ?? state.underlying.price);
      const strike = toNumber(state.selected.strike);
      const volPct = toNumber(state.inputs.volatilityPct ?? state.selected.ivPct);
      const vol = volPct ? volPct / 100 : null;
      const r = toNumber(state.inputs.riskFreePct) / 100;
      const q = toNumber(state.inputs.dividendPct) / 100;
      const t = state.selected.dte ? state.selected.dte / 365 : null;

      if (!spot || !strike || !vol || !t) {
        return null;
      }

      return { spot, strike, vol, r, q, t };
    });

    const metrics = computed(() => {
      if (!state.selected || !selectedInputs.value) return null;
      const { spot, strike, vol, r, q, t } = selectedInputs.value;
      const type = state.selected.type;
      const { d1, d2 } = calcD1D2(spot, strike, vol, r, q, t);
      const nd1 = normalPdf(d1);
      const nd2 = normalCdf(d2);
      const nmd2 = normalCdf(-d2);
      const expQt = Math.exp(-q * t);
      const expRt = Math.exp(-r * t);

      const isCall = type === 'CALL';
      const delta = expQt * (isCall ? normalCdf(d1) : normalCdf(d1) - 1);
      const gamma = (expQt * nd1) / (spot * vol * Math.sqrt(t));
      const vega = spot * expQt * nd1 * Math.sqrt(t) * 0.01;
      const thetaBase = -(spot * expQt * nd1 * vol) / (2 * Math.sqrt(t));
      const theta = isCall
        ? thetaBase - r * strike * expRt * nd2 + q * spot * expQt * normalCdf(d1)
        : thetaBase + r * strike * expRt * nmd2 - q * spot * expQt * normalCdf(-d1);
      const thetaPerDay = theta / 365;
      const probItm = isCall ? nd2 : nmd2;
      const premium = getPremium(state.selected);
      const annualizedYield = premium && t ? (premium / strike) / t * 100 : null;

      return {
        d1,
        d2,
        delta,
        gamma,
        thetaPerDay,
        vega,
        probItm: probItm * 100,
        annualizedYield
      };
    });

    const riskMetrics = computed(() => {
      if (!state.selected) return null;
      const strike = toNumber(state.selected.strike);
      const spot = toNumber(state.inputs.spot ?? state.underlying.price);
      const premium = getPremium(state.selected);
      const isCall = state.selected.type === 'CALL';
      const isSell = state.position === 'SELL';

      if (!strike || !spot || !premium) return null;

      const breakeven = isCall ? strike + premium : strike - premium;
      let maxLoss;
      let maxProfit;

      if (isSell) {
        maxProfit = formatValue(premium * CONTRACT_SIZE);
        if (isCall) {
          maxLoss = '无限';
        } else {
          maxLoss = formatValue((strike - premium) * CONTRACT_SIZE);
        }
      } else {
        maxLoss = formatValue(premium * CONTRACT_SIZE);
        maxProfit = isCall ? '无限' : formatValue((strike - premium) * CONTRACT_SIZE);
      }

      let safetyMargin = null;
      if (isSell) {
        if (isCall && strike > spot) {
          safetyMargin = ((strike - spot) / spot) * 100;
        }
        if (!isCall && spot > strike) {
          safetyMargin = ((spot - strike) / spot) * 100;
        }
      }

      return {
        breakeven,
        maxLoss,
        maxProfit,
        safetyMargin
      };
    });

    const greekNote = computed(() => {
      if (!metrics.value) return '';
      const notes = [];
      if (Math.abs(metrics.value.vega) > 0.3) notes.push('对波动率变化敏感');
      if (Math.abs(metrics.value.gamma) > 0.05) notes.push('Delta变化速度较快');
      if (Math.abs(metrics.value.thetaPerDay) > 0.05) notes.push('时间价值衰减明显');
      if (!notes.length) notes.push('希腊字母处于温和区间');
      return notes.join('；');
    });

    const strategyResult = computed(() => buildStrategy(state));

    const addAlert = () => {
      const target = toNumber(state.alertPrice);
      if (!target) return;
      state.alerts.push({
        id: Date.now(),
        symbol: state.symbol,
        target
      });
      state.alertPrice = null;
    };

    const removeAlert = (id) => {
      state.alerts = state.alerts.filter((alert) => alert.id !== id);
    };

    const selectOption = (row) => {
      state.selected = row;
      if (row.ivPct && !state.inputs.volatilityPct) {
        state.inputs.volatilityPct = row.ivPct;
      }
    };

    const formatNumber = (value, digits = 4) => {
      if (value === null || value === undefined || Number.isNaN(value)) return '--';
      if (typeof value === 'string') return value;
      return value.toFixed(digits);
    };

    const formatPercent = (value, digits = 2) => {
      if (value === null || value === undefined || Number.isNaN(value)) return '--';
      return `${value.toFixed(digits)}%`;
    };

    const formatMoney = (value, digits = 4) => {
      if (value === null || value === undefined || Number.isNaN(value)) return '--';
      return value.toFixed(digits);
    };

    const scheduleChartUpdate = () => {
      requestAnimationFrame(() => {
        renderHistoryChart();
      });
    };

    const renderHistoryChart = () => {
      if (!historyChart) return;
      const data = state.history.data;
      if (!data || !data.length) {
        historyChart.clear();
        return;
      }

      const seriesData = data.map((item) => [item.date, item.close]);
      historyChart.setOption({
        title: { text: '近一年行情走势', left: 'center' },
        tooltip: {
          trigger: 'axis',
          formatter: (params) => {
            const point = params?.[0];
            if (!point) return '';
            const price = Array.isArray(point.data) ? point.data[1] : point.data;
            return `${point.axisValueLabel}<br/>收盘价: ${formatMoney(price, 2)}`;
          }
        },
        xAxis: { type: 'time' },
        yAxis: { type: 'value', scale: true },
        series: [
          {
            name: '收盘价',
            type: 'line',
            data: seriesData,
            smooth: true,
            showSymbol: false,
            areaStyle: { opacity: 0.12 }
          }
        ],
        grid: { left: 50, right: 20, top: 50, bottom: 40 }
      });
    };

    onMounted(() => {
      historyChart = echarts.init(historyChartEl.value);
      window.addEventListener('resize', () => {
        historyChart.resize();
      });
      fetchChain();
    });

    watch(
      () => [state.filterType, state.filterExpiry],
      () => {
        state.pagination.page = 1;
      }
    );

    watch(
      () => [filteredOptions.value.length, state.pagination.pageSize],
      () => {
        const totalPages = Math.max(1, Math.ceil(filteredOptions.value.length / state.pagination.pageSize));
        if (state.pagination.page > totalPages) {
          state.pagination.page = totalPages;
        }
      }
    );

    const handlePageChange = (page) => {
      state.pagination.page = page;
    };

    const handlePageSizeChange = (size) => {
      state.pagination.pageSize = size;
      state.pagination.page = 1;
    };

    return {
      state,
      fetchChain,
      expiryOptions,
      filteredOptions,
      pagedOptions,
      metrics,
      riskMetrics,
      greekNote,
      historyChartEl,
      selectOption,
      formatNumber,
      formatPercent,
      formatMoney,
      handlePageChange,
      handlePageSizeChange
    };
  },
  template: `
    <div class="app-shell">
      <div class="header">
        <div class="header-title">
          <h1>期权分析台</h1>
          <p>价值投资</p>
        </div>
        <div class="search-bar">
          <el-input v-model="state.symbol" placeholder="输入股票代码" style="width: 140px" />
          <el-button type="primary" :loading="state.loading" @click="fetchChain">查询</el-button>
          <el-tag v-if="state.underlying.price" class="tag-accent">
            {{ state.underlying.symbol || state.symbol }} 现价 {{ formatMoney(state.underlying.price, 4) }}
          </el-tag>
        </div>
      </div>

      <div v-if="state.error" class="panel">
        <el-alert :title="state.error" type="error" show-icon />
      </div>

      <div class="main-grid">
        <div class="panel">
          <div class="panel-title">期权链</div>
          <div class="table-meta">
            <el-select v-model="state.filterType" placeholder="类型" style="width: 120px">
              <el-option label="全部" value="ALL" />
              <el-option label="看涨" value="CALL" />
              <el-option label="看跌" value="PUT" />
            </el-select>
            <el-select v-model="state.filterExpiry" placeholder="到期日" style="width: 160px">
              <el-option label="全部" value="ALL" />
              <el-option v-for="expiry in expiryOptions" :key="expiry" :label="expiry" :value="expiry" />
            </el-select>
            <el-tag class="tag-accent">共 {{ filteredOptions.length }} 条</el-tag>
          </div>

          <el-table
            :data="pagedOptions"
            height="520"
            stripe
            @row-click="selectOption"
          >
            <el-table-column prop="type" label="类型" width="70" />
            <el-table-column prop="strike" label="行权价" width="90" />
            <el-table-column prop="expiry" label="到期日" width="110" />
            <el-table-column prop="last" label="权利金" width="90" />
            <el-table-column prop="ivPct" label="IV(%)" width="80" />
            <el-table-column label="全现金年化" width="120">
              <template #default="{ row }">{{ formatPercent(row.allCashYearRate, 1) }}</template>
            </el-table-column>
            <el-table-column label="高保年化(3.3x)" width="140">
              <template #default="{ row }">{{ formatPercent(row.highMarginYearRate, 1) }}</template>
            </el-table-column>
            <el-table-column label="中保年化(1.8x)" width="140">
              <template #default="{ row }">{{ formatPercent(row.midMarginYearRate, 1) }}</template>
            </el-table-column>
            <el-table-column label="中保年化(1.4x)" width="140">
              <template #default="{ row }">{{ formatPercent(row.lowMarginYearRate, 1) }}</template>
            </el-table-column>
            <el-table-column prop="dte" label="DTE" width="70" />
          </el-table>
          <div style="display: flex; justify-content: flex-end; margin-top: 10px">
            <el-pagination
              background
              layout="total, sizes, prev, pager, next"
              :total="filteredOptions.length"
              :page-size="state.pagination.pageSize"
              :page-sizes="state.pagination.pageSizes"
              :current-page="state.pagination.page"
              @size-change="handlePageSizeChange"
              @current-change="handlePageChange"
            />
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">计算结果</div>
          <el-form label-position="top" size="small">
            <el-form-item label="标的价格">
              <el-input-number v-model="state.inputs.spot" :min="0" :step="0.1" style="width: 100%" />
            </el-form-item>
            <el-form-item label="隐含波动率(%)">
              <el-input-number v-model="state.inputs.volatilityPct" :min="0" :step="0.1" style="width: 100%" />
            </el-form-item>
            <el-form-item label="无风险利率(%)">
              <el-input-number v-model="state.inputs.riskFreePct" :min="0" :step="0.1" style="width: 100%" />
            </el-form-item>
            <el-form-item label="股息率(%)">
              <el-input-number v-model="state.inputs.dividendPct" :min="0" :step="0.1" style="width: 100%" />
            </el-form-item>
            <el-form-item label="仓位方向">
              <el-select v-model="state.position" style="width: 100%">
                <el-option label="卖方" value="SELL" />
                <el-option label="买方" value="BUY" />
              </el-select>
            </el-form-item>
          </el-form>

          <div v-if="metrics" class="metric-grid">
            <div class="metric-card">
              <h4>行权概率</h4>
              <p>{{ formatPercent(metrics.probItm, 2) }}</p>
            </div>
            <div class="metric-card">
              <h4>卖方年化收益率</h4>
              <p>{{ formatPercent(metrics.annualizedYield, 2) }}</p>
            </div>
            <div class="metric-card">
              <h4>Delta</h4>
              <p>{{ formatNumber(metrics.delta, 4) }}</p>
            </div>
            <div class="metric-card">
              <h4>Gamma</h4>
              <p>{{ formatNumber(metrics.gamma, 4) }}</p>
            </div>
            <div class="metric-card">
              <h4>Theta(日)</h4>
              <p>{{ formatNumber(metrics.thetaPerDay, 4) }}</p>
            </div>
            <div class="metric-card">
              <h4>Vega(1%)</h4>
              <p>{{ formatNumber(metrics.vega, 4) }}</p>
            </div>
          </div>
          <div v-else class="placeholder">请选择期权或补全输入参数以计算</div>

          <div v-if="riskMetrics" style="margin-top: 16px">
            <div class="panel-title">风险指标</div>
            <div class="metric-grid">
              <div class="metric-card">
                <h4>盈亏平衡点</h4>
                <p>{{ formatMoney(riskMetrics.breakeven, 4) }}</p>
              </div>
              <div class="metric-card">
                <h4>最大收益</h4>
                <p>{{ riskMetrics.maxProfit }}</p>
              </div>
              <div class="metric-card">
                <h4>最大亏损</h4>
                <p>{{ riskMetrics.maxLoss }}</p>
              </div>
              <div class="metric-card">
                <h4>安全边际</h4>
                <p>{{ formatPercent(riskMetrics.safetyMargin, 2) }}</p>
              </div>
            </div>
            <p class="placeholder" style="margin-top: 8px">{{ greekNote }}</p>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">近一年行情走势</div>
        <p v-if="state.history.error" class="placeholder">{{ state.history.error }}</p>
        <p v-else-if="state.history.loading" class="placeholder">行情加载中...</p>
        <p v-else-if="!state.history.data.length" class="placeholder">暂无行情数据</p>
        <div ref="historyChartEl" class="chart"></div>
      </div>
    </div>
  `
};

createApp(app).use(ElementPlus).mount('#app');

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isNaN(number) ? null : number;
}

function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function normalizeChain(raw) {
  if (!raw) return [];
  const data = raw.data || raw.ret_data || raw.result || raw.payload || raw;
  const chainType = detectChainType(raw);
  if (Array.isArray(data)) return normalizeList(data, chainType);

  const list =
    data.optionChain ||
    data.option_chain ||
    data.chain ||
    data.options ||
    data.items ||
    data.list ||
    data;

  if (list && !Array.isArray(list) && typeof list === 'object') {
    const nested =
      list.optionChain ||
      list.option_chain ||
      list.options ||
      list.items ||
      list.list ||
      list.data;
    if (Array.isArray(nested)) return normalizeList(nested, chainType);
  }

  if (Array.isArray(list)) return normalizeList(list);

  const calls = data.calls || data.callList || [];
  const puts = data.puts || data.putList || [];
  if (Array.isArray(calls) || Array.isArray(puts)) {
    return normalizeList([
      ...(Array.isArray(calls) ? calls.map((item) => ({ ...item, type: 'CALL' })) : []),
      ...(Array.isArray(puts) ? puts.map((item) => ({ ...item, type: 'PUT' })) : [])
    ]);
  }

  return [];
}

function normalizeList(list, chainType) {
  return list
    .map((item, index) => {
      const type =
        normalizeType(
          item.type ||
            item.optionType ||
            item.option_type ||
            item.callPut ||
            item.call_put ||
            item.right ||
            item.side
        ) || chainType;
      const strike = toNumber(
        item.strike ||
          item.strikePrice ||
          item.strike_price ||
          item.exercisePrice ||
          item.exercise_price ||
          item.k
      );
      const expiryRaw =
        item.expiry ||
        item.expiryDate ||
        item.expiry_date ||
        item.expiration ||
        item.expirationDate ||
        item.expiration_date ||
        item.expireDate ||
        item.expire_date ||
        item.strikeTime ||
        item.strike_time ||
        item.maturity ||
        item.maturityDate ||
        item.maturity_date ||
        item.expirationTime ||
        item.expiryTime ||
        item.expire_time ||
        item.expiration_time;
      const expiryDate = parseDate(expiryRaw);
      const expiry = expiryDate ? formatDate(expiryDate) : null;
      const dte = expiryDate ? calcDays(expiryDate) : null;
      const bid = toNumber(item.bid || item.bidPrice || item.bid_price || item.bestBid || item.best_bid);
      const ask = toNumber(item.ask || item.askPrice || item.ask_price || item.bestAsk || item.best_ask);
      const last = toNumber(item.last || item.lastPrice || item.last_price || item.price || item.tradePrice);
      const iv = toNumber(
        item.iv ||
          item.impliedVolatility ||
          item.implied_volatility ||
          item.volatility ||
          item.ivRate ||
          item.iv_rate ||
          item.impVol
      );
      const ivPct = iv === null ? null : (iv > 1 ? iv : iv * 100);
      const openInterest = toNumber(item.openInterest || item.oi || item.open_interest);
      const volume = toNumber(item.volume || item.vol || item.tradeVolume || item.trade_volume);
      const highMarginYearRate = toNumber(item.highMarginYearRate || item.high_margin_year_rate);
      const midMarginYearRate = toNumber(item.midMarginYearRate || item.mid_margin_year_rate);
      const lowMarginYearRate = toNumber(item.lowMarginYearRate || item.low_margin_year_rate);
      const allCashYearRate = toNumber(item.allCashYearRate || item.all_cash_year_rate);
      const mid = bid !== null && ask !== null ? (bid + ask) / 2 : last;

      return {
        id: item.id || `${type}-${strike}-${expiry}-${index}`,
        type: type || 'CALL',
        strike,
        expiry,
        dte,
        bid: bid === null ? null : round(bid, 4),
        ask: ask === null ? null : round(ask, 4),
        last: last === null ? null : round(last, 4),
        ivPct: ivPct === null ? null : round(ivPct, 2),
        openInterest,
        volume,
        highMarginYearRate,
        midMarginYearRate,
        lowMarginYearRate,
        allCashYearRate,
        mid: mid === null ? null : round(mid, 4),
        raw: item
      };
    })
    .filter((item) => item.strike !== null && item.strike !== undefined && item.expiry);
}

function normalizeType(value) {
  if (!value) return null;
  const upper = String(value).toUpperCase();
  if (upper.includes('CALL') || upper === 'C') return 'CALL';
  if (upper.includes('PUT') || upper === 'P') return 'PUT';
  return null;
}

function detectChainType(raw) {
  const name =
    raw?.stockName ||
    raw?.data?.stockName ||
    raw?.ret_data?.stockName ||
    raw?.result?.stockName;
  if (!name) return null;
  const upper = String(name).toUpperCase();
  if (upper.includes('CALL') || /C$/.test(upper)) return 'CALL';
  if (upper.includes('PUT') || /P$/.test(upper)) return 'PUT';
  return null;
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    const asString = String(value);
    if (/^\d{8}$/.test(asString) || /^\d{6}$/.test(asString)) {
      return parseDate(asString);
    }
    const timestamp = value > 1e12 ? value : value * 1000;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const clean = value.trim();
    if (/^\d{8}$/.test(clean)) {
      const year = Number(clean.slice(0, 4));
      const month = Number(clean.slice(4, 6)) - 1;
      const day = Number(clean.slice(6, 8));
      return new Date(year, month, day);
    }
    if (/^\d{6}$/.test(clean)) {
      const year = 2000 + Number(clean.slice(0, 2));
      const month = Number(clean.slice(2, 4)) - 1;
      const day = Number(clean.slice(4, 6));
      return new Date(year, month, day);
    }
    const date = new Date(clean);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calcDays(expiryDate) {
  const now = new Date();
  const diff = expiryDate.getTime() - now.getTime();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return days > 0 ? days : 0;
}

function extractUnderlying(raw, options, fallbackSymbol) {
  const data = raw?.data || raw?.ret_data || raw?.result || raw;
  const price =
    toNumber(data?.underlyingPrice) ||
    toNumber(data?.spotPrice) ||
    toNumber(data?.stockPrice) ||
    toNumber(data?.stock?.price) ||
    toNumber(data?.stock?.last_price) ||
    toNumber(data?.underlying?.price) ||
    toNumber(data?.underlying_price) ||
    toNumber(options?.[0]?.raw?.underlyingPrice);

  return {
    symbol:
      data?.symbol ||
      data?.underlyingSymbol ||
      data?.underlying?.symbol ||
      data?.stock?.symbol ||
      data?.stock?.code ||
      fallbackSymbol,
    price
  };
}

function getPremium(option) {
  if (!option) return null;
  return toNumber(option.mid || option.last || option.bid || option.ask);
}

function normalCdf(x) {
  return 0.5 * (1 + math.erf(x / Math.sqrt(2)));
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function calcD1D2(spot, strike, vol, r, q, t) {
  const numerator = Math.log(spot / strike) + (r - q + 0.5 * vol * vol) * t;
  const denominator = vol * Math.sqrt(t);
  const d1 = numerator / denominator;
  const d2 = d1 - vol * Math.sqrt(t);
  return { d1, d2 };
}

function buildPriceCurve(option, inputs) {
  const { strike, vol, r, q, t } = inputs;
  const spotRange = buildSpotRange(inputs.spot, [strike]);
  const series = [];

  spotRange.forEach((spot) => {
    const { d1, d2 } = calcD1D2(spot, strike, vol, r, q, t);
    const expQt = Math.exp(-q * t);
    const expRt = Math.exp(-r * t);
    const callPrice = spot * expQt * normalCdf(d1) - strike * expRt * normalCdf(d2);
    const putPrice = strike * expRt * normalCdf(-d2) - spot * expQt * normalCdf(-d1);
    const price = option.type === 'CALL' ? callPrice : putPrice;
    series.push([round(spot, 2), round(price, 4)]);
  });

  return series;
}

function buildSpotRange(spot, strikes) {
  const base = spot || strikes[0] || 1;
  const minStrike = Math.min(...strikes);
  const maxStrike = Math.max(...strikes);
  const min = Math.max(0.5 * base, minStrike * 0.7);
  const max = Math.max(base * 1.5, maxStrike * 1.3);
  const steps = 80;
  const step = (max - min) / steps;
  const range = [];
  for (let i = 0; i <= steps; i += 1) {
    range.push(min + step * i);
  }
  return range;
}

function buildStrategy(state) {
  const option = state.selected;
  if (!option) {
    return { error: '请先选择期权合约' };
  }

  const spot = toNumber(state.inputs.spot ?? state.underlying.price);
  if (!spot) {
    return { error: '请补全标的价格' };
  }

  const strategy = state.strategy.type;
  const premium = getPremium(option);
  if (!premium) {
    return { error: '缺少期权价格用于策略计算' };
  }

  const strikes = [option.strike];
  const legs = [];
  let description = '';
  let maxProfit = '--';
  let maxLoss = '--';
  let breakevens = '--';

  if (strategy === 'covered_call') {
    if (option.type !== 'CALL') return { error: '备兑看涨需选择看涨期权' };
    legs.push({
      label: '买入标的',
      payoff: (s) => (s - spot) * CONTRACT_SIZE
    });
    legs.push({
      label: '卖出看涨',
      payoff: (s) => (premium - Math.max(s - option.strike, 0)) * CONTRACT_SIZE
    });
    description = `买入100股 + 卖出1张${option.strike}看涨期权。`;
    maxProfit = formatValue((option.strike - spot + premium) * CONTRACT_SIZE);
    maxLoss = formatValue((spot - premium) * CONTRACT_SIZE);
    breakevens = formatValue(spot - premium);
  }

  if (strategy === 'protective_put') {
    if (option.type !== 'PUT') return { error: '保护性看跌需选择看跌期权' };
    legs.push({
      label: '买入标的',
      payoff: (s) => (s - spot) * CONTRACT_SIZE
    });
    legs.push({
      label: '买入看跌',
      payoff: (s) => (Math.max(option.strike - s, 0) - premium) * CONTRACT_SIZE
    });
    description = `买入100股 + 买入1张${option.strike}看跌期权。`;
    maxProfit = '无限';
    maxLoss = formatValue((spot - option.strike + premium) * CONTRACT_SIZE);
    breakevens = formatValue(spot + premium);
  }

  if (strategy === 'straddle') {
    const pair = findPairOption(state.options, option, 'same');
    if (!pair) return { error: '跨式策略需要同到期的看涨与看跌期权' };
    const pairPremium = getPremium(pair);
    if (!pairPremium) return { error: '跨式策略缺少配对期权价格' };
    const totalPremium = premium + pairPremium;
    strikes.push(pair.strike);
    legs.push({
      label: '买入看涨',
      payoff: (s) => (Math.max(s - option.strike, 0) - premium) * CONTRACT_SIZE
    });
    legs.push({
      label: '买入看跌',
      payoff: (s) => (Math.max(option.strike - s, 0) - pairPremium) * CONTRACT_SIZE
    });
    description = `买入同到期同执行价的看涨/看跌。`;
    maxProfit = '无限';
    maxLoss = formatValue(totalPremium * CONTRACT_SIZE);
    breakevens = `${formatValue(option.strike + totalPremium)}, ${formatValue(option.strike - totalPremium)}`;
  }

  if (strategy === 'strangle') {
    const callLeg = option.type === 'CALL' ? option : findPairOption(state.options, option, 'callHigher');
    const putLeg = option.type === 'PUT' ? option : findPairOption(state.options, option, 'putLower');
    if (!callLeg || !putLeg) return { error: '宽跨式需要同到期的看涨与看跌期权' };
    const callPremium = getPremium(callLeg);
    const putPremium = getPremium(putLeg);
    if (!callPremium || !putPremium) return { error: '宽跨式策略缺少期权价格' };
    const totalPremium = callPremium + putPremium;
    strikes.push(callLeg.strike, putLeg.strike);
    legs.push({
      label: '买入看涨',
      payoff: (s) => (Math.max(s - callLeg.strike, 0) - callPremium) * CONTRACT_SIZE
    });
    legs.push({
      label: '买入看跌',
      payoff: (s) => (Math.max(putLeg.strike - s, 0) - putPremium) * CONTRACT_SIZE
    });
    description = `买入高执行价看涨 + 低执行价看跌。`;
    maxProfit = '无限';
    maxLoss = formatValue(totalPremium * CONTRACT_SIZE);
    breakevens = `${formatValue(callLeg.strike + totalPremium)}, ${formatValue(putLeg.strike - totalPremium)}`;
  }

  if (strategy === 'bull_call') {
    if (option.type !== 'CALL') return { error: '牛市价差需选择看涨期权' };
    const shortCall = findPairOption(state.options, option, 'callHigher');
    if (!shortCall) return { error: '未找到更高执行价的看涨期权' };
    const shortPremium = getPremium(shortCall);
    if (!shortPremium) return { error: '牛市价差缺少配对期权价格' };
    const netPremium = premium - shortPremium;
    strikes.push(shortCall.strike);
    legs.push({
      label: '买入看涨',
      payoff: (s) => (Math.max(s - option.strike, 0) - premium) * CONTRACT_SIZE
    });
    legs.push({
      label: '卖出看涨',
      payoff: (s) => (shortPremium - Math.max(s - shortCall.strike, 0)) * CONTRACT_SIZE
    });
    description = `买入较低执行价看涨 + 卖出更高执行价看涨。`;
    maxProfit = formatValue((shortCall.strike - option.strike - netPremium) * CONTRACT_SIZE);
    maxLoss = formatValue(netPremium * CONTRACT_SIZE);
    breakevens = formatValue(option.strike + netPremium);
  }

  if (strategy === 'bear_put') {
    if (option.type !== 'PUT') return { error: '熊市价差需选择看跌期权' };
    const shortPut = findPairOption(state.options, option, 'putLower');
    if (!shortPut) return { error: '未找到更低执行价的看跌期权' };
    const shortPremium = getPremium(shortPut);
    if (!shortPremium) return { error: '熊市价差缺少配对期权价格' };
    const netPremium = premium - shortPremium;
    strikes.push(shortPut.strike);
    legs.push({
      label: '买入看跌',
      payoff: (s) => (Math.max(option.strike - s, 0) - premium) * CONTRACT_SIZE
    });
    legs.push({
      label: '卖出看跌',
      payoff: (s) => (shortPremium - Math.max(shortPut.strike - s, 0)) * CONTRACT_SIZE
    });
    description = `买入较高执行价看跌 + 卖出更低执行价看跌。`;
    maxProfit = formatValue((option.strike - shortPut.strike - netPremium) * CONTRACT_SIZE);
    maxLoss = formatValue(netPremium * CONTRACT_SIZE);
    breakevens = formatValue(option.strike - netPremium);
  }

  if (!legs.length) {
    return { error: '策略暂不可用，请重新选择合约' };
  }

  const spotRange = buildSpotRange(spot, strikes);
  const series = spotRange.map((s) => {
    const payoff = legs.reduce((sum, leg) => sum + leg.payoff(s), 0);
    return [round(s, 2), round(payoff, 2)];
  });

  return {
    name: strategyName(strategy),
    description,
    series,
    maxProfit,
    maxLoss,
    breakevens
  };
}

function strategyName(type) {
  const mapping = {
    covered_call: '备兑看涨',
    protective_put: '保护性看跌',
    straddle: '跨式',
    strangle: '宽跨式',
    bull_call: '牛市价差',
    bear_put: '熊市价差'
  };
  return mapping[type] || '策略';
}

function findPairOption(options, base, mode) {
  const candidates = options.filter((option) => option.expiry === base.expiry);
  if (mode === 'same') {
    return candidates.find(
      (option) => option.strike === base.strike && option.type !== base.type
    );
  }
  if (mode === 'callHigher') {
    return candidates
      .filter((option) => option.type === 'CALL' && option.strike > base.strike)
      .sort((a, b) => a.strike - b.strike)[0];
  }
  if (mode === 'putLower') {
    return candidates
      .filter((option) => option.type === 'PUT' && option.strike < base.strike)
      .sort((a, b) => b.strike - a.strike)[0];
  }
  return null;
}

function formatValue(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  if (typeof value === 'string') return value;
  return value.toFixed(2);
}
