<!--
  评估结果页：信用评分仪表盘 / 风险等级 / 违约概率 / 授信建议 / 指标贡献图 / 前三项扣分原因，
  支持打印报告、查看原始表单、历史评估记录（分页/查看/回填/删除）。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRiskStore } from '@/stores/risk'
import * as echarts from 'echarts'
import ScoreGauge from '@/components/ScoreGauge.vue'
import RiskBadge from '@/components/RiskBadge.vue'
import RiskAlertModal from '@/components/RiskAlertModal.vue'
import DataTransparency from '@/components/DataTransparency.vue'
import { deleteRiskRecord, getRiskRecord, getRiskRecords, getRiskReview, openRiskReviewStream, requestRiskReview, updateRiskRecordOutcome } from '@/api/risk'
import type { AIReview, AssessmentOutcome, AssessmentRecordDetail, AssessmentRecordItem, ReviewItem } from '@/api/types'
import { APP_FULL_NAME, APP_VERSION, TOKEN_KEY } from '@/constants'
import { SSEParser } from '@/utils/sse'

const shownAlertResults = new WeakSet<object>()
const router = useRouter()
const riskStore = useRiskStore()
const authStore = useAuthStore()

const barChartRef = ref<HTMLElement>()
let barChart: echarts.ECharts | null = null

function handleResize() {
  if (barChart) barChart.resize()
}

// 有数据时初始化图表
onMounted(() => {
  if (riskStore.hasResult) {
    initBarChart()
  }
  window.addEventListener('resize', handleResize)
  loadHistory()
  const queryId = Number(router.currentRoute.value.query.recordId)
  const id = Number.isInteger(queryId) && queryId > 0 ? queryId : viewingHistoryId.value
  if (id) void restoreRecord(id)
  else if (result.value?.recordId) {
    void router.replace({ path: '/result', query: { recordId: String(result.value.recordId) } })
  }
})

onBeforeUnmount(() => {
  stopReviewUpdates()
  restoreAbort?.abort()
  clearRetryCountdown()
  window.removeEventListener('resize', handleResize)
  barChart?.dispose()
  barChart = null
})

const result = computed(() => riskStore.riskResult!)
const aiReview = computed(() => result.value?.aiReview)
const reviewTimedOut = ref(false)
const reviewStatusText = computed(() => {
  const status = aiReview.value?.status
  if (status === 'pending') return reviewTimedOut.value
    ? '复核仍在生成中，已暂停自动等待；稍后重新打开本记录可查看最新状态。'
    : '正在生成复核提示…'
  if (status === 'failed') return aiReview.value?.message || '复核提示生成失败'
  if (status === 'disabled') return 'AI 复核未启用，以下为通用核验规则。'
  if (status === 'not_applicable') return '本条记录没有可复核的已计分指标，以下为通用核验规则。'
  if (!status || status === 'not_requested') return '暂无生成的复核提示，以下为通用核验规则。'
  return ''
})
const retryCountdown = ref(0)
let retryCountdownTimer = 0
const retrySubmitting = ref(false)

let reviewAbort: AbortController | null = null
let restoreAbort: AbortController | null = null
let reviewRun = 0
let previewFrame = 0
let pendingPreview: AIReview | null = null
const reviewDeadlineMs = 90_000

function isTerminalReviewError(error: unknown) {
  return [401, 403, 404].includes((error as { code?: number }).code || 0)
}

function stopReviewUpdates() {
  reviewRun++
  reviewAbort?.abort()
  reviewAbort = null
  if (previewFrame) cancelAnimationFrame(previewFrame)
  previewFrame = 0
  pendingPreview = null
}

function clearRetryCountdown() {
  window.clearInterval(retryCountdownTimer)
  retryCountdownTimer = 0
}

watch(aiReview, (review) => {
  clearRetryCountdown()
  retryCountdown.value = review?.status === 'failed' && review.retryable ? Math.max(0, review.retryAfter) : 0
  if (retryCountdown.value > 0) {
    retryCountdownTimer = window.setInterval(() => {
      retryCountdown.value = Math.max(0, retryCountdown.value - 1)
      if (retryCountdown.value === 0) {
        window.clearInterval(retryCountdownTimer)
        retryCountdownTimer = 0
      }
    }, 1000)
  }
}, { immediate: true })

type ReviewSnapshotDecision = 'apply' | 'ignore' | 'stop'

function reviewSnapshotDecision(snapshot: AIReview, expectedRecordId: number, run: number, token: string): ReviewSnapshotDecision {
  if (run !== reviewRun || localStorage.getItem(TOKEN_KEY) !== token || snapshot.recordId !== expectedRecordId) return 'stop'
  const current = riskStore.riskResult
  if (!current || (current.recordId && current.recordId !== expectedRecordId)) return 'stop'
  const previous = current.aiReview
  if (previous && snapshot.attemptId < previous.attemptId) return 'ignore'
  // Versions are scoped to an attempt and may restart at 1 after a manual retry.
  if (previous && snapshot.attemptId === previous.attemptId && snapshot.version < previous.version) return 'ignore'
  if (previous && snapshot.attemptId === previous.attemptId && previous.status !== 'pending') return 'stop'
  return 'apply'
}

function applyReviewSnapshot(snapshot: AIReview, expectedRecordId: number, run: number, token: string) {
  const decision = reviewSnapshotDecision(snapshot, expectedRecordId, run, token)
  if (decision === 'ignore') return riskStore.riskResult?.aiReview?.status === 'pending'
  if (decision === 'stop') return false
  const current = riskStore.riskResult
  if (!current) return false
  // Nested assignment keeps the result object identity stable for the alert watcher.
  current.aiReview = snapshot
  return snapshot.status === 'pending'
}

function queueReviewSnapshot(snapshot: AIReview, recordId: number, run: number, token: string) {
  if (reviewSnapshotDecision(snapshot, recordId, run, token) !== 'apply') return
  const queued = pendingPreview
  if (queued && (snapshot.attemptId < queued.attemptId ||
    (snapshot.attemptId === queued.attemptId && snapshot.version <= queued.version))) return
  pendingPreview = snapshot
  if (previewFrame) return
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0
    const latest = pendingPreview
    pendingPreview = null
    if (latest) applyReviewSnapshot(latest, recordId, run, token)
  })
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = window.setTimeout(finish, ms)
    const abort = () => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

async function readReviewStream(recordId: number, controller: AbortController, run: number, token: string): Promise<boolean> {
  const response = await openRiskReviewStream(recordId, controller.signal)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let terminal = false
  const parser = new SSEParser((event) => {
    try {
      const snapshot = JSON.parse(event.data) as AIReview
      const decision = reviewSnapshotDecision(snapshot, recordId, run, token)
      if (decision === 'apply') {
        queueReviewSnapshot(snapshot, recordId, run, token)
        if (snapshot.status !== 'pending') terminal = true
      } else if (decision === 'stop' && riskStore.riskResult?.aiReview?.status !== 'pending') {
        terminal = true
      }
    } catch {
      // Ignore malformed frames and keep the stream alive for the next complete snapshot.
    }
  })
  try {
    while (run === reviewRun && localStorage.getItem(TOKEN_KEY) === token) {
      const { done, value } = await reader.read()
      if (done) {
        parser.feed(decoder.decode())
        parser.finish()
        return terminal
      }
      parser.feed(decoder.decode(value, { stream: true }))
      if (terminal) return true
    }
    return false
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function startReviewUpdates(recordId: number, initial: AIReview) {
  stopReviewUpdates()
  reviewTimedOut.value = false
  if (initial.status !== 'pending') return
  const run = reviewRun
  const token = localStorage.getItem(TOKEN_KEY) || ''
  const controller = new AbortController()
  reviewAbort = controller
  const deadline = performance.now() + reviewDeadlineMs
  const deadlineTimer = window.setTimeout(() => {
    const activeRecordId = riskStore.riskResult?.recordId || viewingHistoryId.value
    if (run === reviewRun && activeRecordId === recordId) reviewTimedOut.value = true
    controller.abort()
  }, reviewDeadlineMs)
  try {
    const retryDelays = [1000, 2000, 4000]
    for (let connectionIndex = 0; connectionIndex <= retryDelays.length; connectionIndex++) {
      if (controller.signal.aborted || run !== reviewRun || localStorage.getItem(TOKEN_KEY) !== token || performance.now() >= deadline) return
      if (connectionIndex > 0) {
        const waitMs = retryDelays[connectionIndex - 1]
        if (performance.now() + waitMs >= deadline) return
        try { await delay(waitMs, controller.signal) } catch { return }
      }
      let terminal = false
      try {
        terminal = await readReviewStream(recordId, controller, run, token)
      } catch (error) {
        if (controller.signal.aborted || run !== reviewRun || isTerminalReviewError(error)) return
      }
      if (terminal || controller.signal.aborted || run !== reviewRun) return

      // Reconcile after every disconnect before retrying or switching to polling.
      try {
        const snapshot = await getRiskReview(recordId, controller.signal)
        if (!applyReviewSnapshot(snapshot, recordId, run, token)) return
      } catch (error) {
        if (controller.signal.aborted || run !== reviewRun || isTerminalReviewError(error)) return
      }
    }

    // Once the initial connection and three backoff retries are exhausted, poll only.
    while (performance.now() < deadline && !controller.signal.aborted && run === reviewRun && localStorage.getItem(TOKEN_KEY) === token) {
      try { await delay(Math.min(2000, deadline - performance.now()), controller.signal) } catch { return }
      if (controller.signal.aborted || run !== reviewRun || localStorage.getItem(TOKEN_KEY) !== token) return
      try {
        const snapshot = await getRiskReview(recordId, controller.signal)
        if (!applyReviewSnapshot(snapshot, recordId, run, token)) return
      } catch (error) {
        if (controller.signal.aborted || run !== reviewRun || isTerminalReviewError(error)) return
      }
    }
  } finally {
    window.clearTimeout(deadlineTimer)
  }
}

async function restoreRecord(recordId: number) {
  stopReviewUpdates()
  restoreAbort?.abort()
  const controller = new AbortController()
  restoreAbort = controller
  const run = reviewRun
  const token = localStorage.getItem(TOKEN_KEY) || ''
  try {
    const detail = await getRiskRecord(recordId, controller.signal)
    if (run !== reviewRun || token !== (localStorage.getItem(TOKEN_KEY) || '')) return
    if (!detail.result) {
      ElMessage.warning('该记录缺少结果快照，无法查看')
      return
    }
    let review = detail.result.aiReview
    try {
      // The task state can advance independently from the immutable result snapshot.
      // GET is read-only and gives history restores the current attempt/version.
      review = await getRiskReview(recordId, controller.signal)
    } catch {
      if (run !== reviewRun || token !== (localStorage.getItem(TOKEN_KEY) || '')) return
      // Older records may only have an embedded snapshot, which remains usable.
    }
    if (run !== reviewRun || token !== (localStorage.getItem(TOKEN_KEY) || '')) return
    const restored = { ...detail.result, recordId, aiReview: review }
    riskStore.setResult(restored)
    currentHistoryName.value = detail.enterpriseName || ''
    viewingHistoryId.value = recordId
    riskStore.setHistoryRecordId(recordId)
    currentHistoryDetail.value = detail
    await nextTick()
    if (run !== reviewRun || token !== (localStorage.getItem(TOKEN_KEY) || '')) return
    initBarChart()
    if (restored.aiReview) startReviewUpdates(recordId, restored.aiReview)
  } catch {
    // 错误已由拦截器提示
  }
}

interface ReviewDisplayRow {
  position: number
  code: string
  factor: string
  score: number
  explanation: string
  checks: string[]
  generated: boolean
  streaming: boolean
}

const neutralHighScoreText = '该指标当前得分较高，请按本机构现行审核规则核验相关材料。'
const generalReviewText = '请按本机构现行信贷审核规则核验经营真实性、现金流、偿债能力及相关证明材料。'

function buildReviewRows(items: ReviewItem[], status?: AIReview['status']): ReviewDisplayRow[] {
  return (result.value?.deductions || []).slice(0, 3).map((deduction, position) => {
    const item = items.find((candidate) => candidate.position === position && candidate.code === deduction.code)
    return {
      position,
      code: deduction.code || '',
      factor: deduction.factor,
      score: deduction.score,
      explanation: item?.explanation || (deduction.score >= 80 ? neutralHighScoreText : deduction.reason),
      checks: item?.checks || [],
      generated: status === 'ready' && !!item,
      streaming: status === 'pending' && !!item,
    }
  })
}

const reviewRows = computed(() => {
  const review = aiReview.value
  return buildReviewRows(review?.status === 'ready' ? review.items : review?.status === 'pending' ? review.preview : [], review?.status)
})
const printReviewRows = computed(() => {
  const review = aiReview.value
  return buildReviewRows(review?.status === 'ready' ? review.items : [], review?.status)
})

async function retryReview() {
  const recordId = result.value?.recordId || viewingHistoryId.value
  if (!recordId || retrySubmitting.value) return
  const run = reviewRun
  const token = localStorage.getItem(TOKEN_KEY) || ''
  const expectedRecordId = recordId
  const retryable = aiReview.value?.status === 'not_requested' ||
    (aiReview.value?.status === 'failed' && aiReview.value.retryable)
  if (!retryable || retryCountdown.value > 0) return
  retrySubmitting.value = true
  try {
    const snapshot = await requestRiskReview(recordId)
    if (
      run !== reviewRun || token !== (localStorage.getItem(TOKEN_KEY) || '') ||
      (riskStore.riskResult?.recordId || viewingHistoryId.value) !== expectedRecordId
    ) return
    if (riskStore.riskResult) riskStore.riskResult.aiReview = snapshot
    startReviewUpdates(recordId, snapshot)
  } catch {
    // 错误已由拦截器提示
  } finally {
    retrySubmitting.value = false
  }
}

watch(
  () => router.currentRoute.value.query.recordId,
  (value, oldValue) => {
    if (value === oldValue) return
    const id = Number(value)
    if (Number.isInteger(id) && id > 0) void restoreRecord(id)
    else {
      stopReviewUpdates()
      restoreAbort?.abort()
    }
  }
)

// ---------- 历史评估记录（当前账号）----------
const historyRecords = ref<AssessmentRecordItem[]>([])
const historyTotal = ref(0)
const historyPage = ref(1)
const historySize = 8
const historyLoading = ref(false)
const outcomeVisible = ref(false)
const outcomeSaving = ref(false)
const outcomeForm = ref({ id: 0, enterpriseName: '', outcome: 'pending' as AssessmentOutcome, note: '' })
const OUTCOME_OPTIONS = [
  { label: '正常还款', value: 'normal', type: 'success' },
  { label: '逾期', value: 'overdue', type: 'danger' },
  { label: '未放款', value: 'rejected', type: 'info' },
  { label: '待回填', value: 'pending', type: 'warning' },
] as const
// 当前正在查看的历史记录（用于标题展示与删除联动）
const viewingHistoryId = ref(riskStore.historyRecordId || 0)
const currentHistoryName = ref('')
// 当前历史详情（含原始指标明细，供「查看原始表单」）
const currentHistoryDetail = ref<AssessmentRecordDetail | null>(null)
const alertModalVisible = ref(false)
const transparencyRef = ref<{ scrollToIndicator: (code: string) => void } | null>(null)
const activeAlerts = computed(() =>
  (result.value?.riskAlerts || []).filter((alert) => alert.severity === 'veto' || alert.severity === 'high')
)

watch(() => authStore.token, (token, previousToken) => {
  stopReviewUpdates()
  restoreAbort?.abort()
  if (previousToken && token !== previousToken) {
    riskStore.clearSessionData()
    currentHistoryName.value = ''
    viewingHistoryId.value = 0
    currentHistoryDetail.value = null
    formRows.value = []
    formDrawerVisible.value = false
    historyRecords.value = []
    historyTotal.value = 0
    historyPage.value = 1
  }
})

watch(
  () => result.value,
  (nextResult) => {
    const alerts = (nextResult?.riskAlerts || []).filter(
      (alert) => alert.severity === 'veto' || alert.severity === 'high'
    )
    if (!nextResult || !alerts.length || shownAlertResults.has(nextResult)) return
    shownAlertResults.add(nextResult)
    alertModalVisible.value = true
  },
  { immediate: true }
)

// ---------- 原始表单查看 ----------
const formDrawerVisible = ref(false)
const formRows = ref<{ name: string; level: string; unit: string; value: string }[]>([])

function showForm() {
  if (viewingHistoryId.value) {
    if (!currentHistoryDetail.value) {
      ElMessage.info('历史记录详情正在加载，请稍后再试')
      return
    }
    const iv = currentHistoryDetail.value.indicatorValues || []
    formRows.value = iv.map((r) => ({ name: r.name, level: r.level, unit: r.unit, value: r.value ?? '' }))
  } else {
    formRows.value = riskStore.formSnapshot.map((s) => ({ name: s.name, level: s.level, unit: s.unit, value: s.value }))
  }
  formDrawerVisible.value = true
}

async function loadHistory(page = 1) {
  historyLoading.value = true
  try {
    const data = await getRiskRecords({ page, size: historySize })
    historyRecords.value = data.items
    historyTotal.value = data.total
    historyPage.value = page
  } catch {
    // 错误已由拦截器提示
  } finally {
    historyLoading.value = false
  }
}

function formatTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function viewHistory(recordId: number) {
  if (String(router.currentRoute.value.query.recordId || '') !== String(recordId)) {
    await router.replace({ path: '/result', query: { recordId: String(recordId) } })
  } else {
    await restoreRecord(recordId)
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function outcomeOption(outcome?: AssessmentOutcome) {
  return OUTCOME_OPTIONS.find((option) => option.value === outcome) || OUTCOME_OPTIONS[3]
}

function openOutcome(row: AssessmentRecordItem) {
  if (outcomeSaving.value) return
  outcomeForm.value = {
    id: row.id,
    enterpriseName: row.enterpriseName,
    outcome: row.outcome || 'pending',
    note: row.outcomeNote || '',
  }
  outcomeVisible.value = true
}

async function saveOutcome() {
  if (outcomeSaving.value) return
  outcomeSaving.value = true
  try {
    const updated = await updateRiskRecordOutcome(outcomeForm.value.id, {
      outcome: outcomeForm.value.outcome,
      note: outcomeForm.value.note,
    })
    historyRecords.value = historyRecords.value.map((row) => (row.id === updated.id ? { ...row, ...updated } : row))
    if (currentHistoryDetail.value?.id === updated.id) {
      Object.assign(currentHistoryDetail.value, {
        outcome: updated.outcome,
        outcomeNote: updated.outcomeNote,
        outcomeAt: updated.outcomeAt,
      })
    }
    outcomeVisible.value = false
    ElMessage.success('已回填')
  } catch {
    // 错误已由拦截器提示，保留弹窗和已填写内容供重试。
  } finally {
    outcomeSaving.value = false
  }
}

async function removeHistory(row: AssessmentRecordItem) {
  try {
    await ElMessageBox.confirm(`确认删除「${row.enterpriseName}」的评估记录？删除后不可恢复。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await deleteRiskRecord(row.id)
    ElMessage.success('已删除')
    if (viewingHistoryId.value === row.id) {
      stopReviewUpdates()
      riskStore.setResult(null)
      currentHistoryName.value = ''
      viewingHistoryId.value = 0
      currentHistoryDetail.value = null
      riskStore.setHistoryRecordId(null)
      await router.replace({ path: '/result' })
    }
    if (historyRecords.value.length === 1 && historyPage.value > 1) {
      loadHistory(historyPage.value - 1)
    } else {
      loadHistory(historyPage.value)
    }
  } catch {
    // 错误已由拦截器提示
  }
}

// 贡献图移动端最小宽度（每个指标约 96px），超出时容器横向滑动
const contributionMinWidth = computed(() => (result.value?.contributions?.length || 6) * 96)

const probabilityPercent = computed(() => (result.value ? (result.value.probability * 100).toFixed(2) : '0.00'))

// 打印报告
const printDate = computed(() => new Date().toLocaleString('zh-CN'))
const reportTitle = computed(() => currentHistoryName.value || riskStore.dynamicForm.enterpriseName || '涉农经营主体')

// 报告编号（按时间生成）
const reportNo = computed(() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `RACE-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
})

// 经营类型显示名（大类码 → 名称）
const BIG_TYPE_NAMES: Record<string, string> = {
  '01': '农林牧渔业',
  '02': '食用加工与制造',
  '03': '非食用加工与制造',
  '04': '生产资料制造和农田水利设施建设',
  '05': '流通服务',
  '06': '科研和技术服务',
  '07': '教育培训与人力资源服务',
  '08': '生态保护和环境治理',
  '09': '休闲观光与农业农村管理服务',
  '10': '其他支持服务',
}
const businessTypeText = computed(() => {
  const bt = riskStore.dynamicForm.businessType || ''
  if (!bt) return '—'
  if (bt === 'MIXED') return '混合经营'
  return BIG_TYPE_NAMES[bt] || bt
})

const sortedContribs = computed(() => [...(result.value?.contributions || [])].sort((a, b) => b.score - a.score))
const completenessText = computed(() =>
  result.value?.completeness != null ? `${(result.value.completeness * 100).toFixed(0)}%` : '—'
)

function handlePrint() {
  window.print()
}

function initBarChart() {
  if (!barChartRef.value || !result.value) return
  barChart?.dispose()
  const chart = echarts.init(barChartRef.value)
  barChart = chart

  // 拷贝后排序，避免原地修改 store 中的共享数组
  const contribs = sortedContribs.value
  const factorCount = contribs.length

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: { name: string; value: number }[]) => {
        const p = params[0]
        return `${p.name}<br/>得分：${p.value.toFixed(1)} 分`
      },
    },
    // 纵向柱状图：指标名称在底部横轴，容器可横向滑动，避免左侧长名称占位过大
    grid: { top: 32, right: 20, bottom: 28, left: 46 },
    xAxis: {
      type: 'category',
      data: contribs.map((c) => c.factor),
      axisLabel: {
        fontSize: 10,
        interval: 0,
        // 指标较多时倾斜避免重叠
        rotate: factorCount >= 7 ? 25 : 0,
      },
    },
    yAxis: {
      type: 'value',
      max: 100,
      axisLabel: { formatter: '{value}分', fontSize: 10 },
    },
    series: [
      {
        type: 'bar',
        data: contribs.map((c) => ({
          value: c.score,
          itemStyle: {
            color: c.score >= 80 ? '#67c23a' : c.score >= 60 ? '#e6a23c' : '#f56c6c',
            borderRadius: [4, 4, 0, 0],
          },
        })),
        barWidth: 26,
        label: {
          show: true,
          position: 'top',
          formatter: '{c}',
          fontSize: 11,
        },
      },
    ],
  })
}

function goBack() {
  router.push('/input')
}

function supplementData(code = '') {
  const historyId = viewingHistoryId.value || riskStore.historyRecordId
  if (historyId) {
    router.push({ path: '/input', query: { recordId: String(historyId), focusCode: code || undefined } })
    return
  }
  router.push({ path: '/input', query: { restoreCurrent: '1', focusCode: code || undefined } })
}

async function jumpToIndicator(code: string) {
  await nextTick()
  if (code) transparencyRef.value?.scrollToIndicator(code)
  else document.getElementById('data-transparency')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <div class="result-page">
    <div class="page-container">
      <template v-if="result">
        <div class="page-header">
          <h1>风险评估结果</h1>
          <p>基于多元统计模型的综合信贷风险分析报告</p>
        </div>

        <!-- 核心指标卡片 -->
        <el-row :gutter="20" class="result-cards">
          <!-- 信用评分仪表盘 -->
          <el-col :xs="24" :md="8">
            <div class="info-card gauge-card">
              <h3 class="card-title">信用评分（0-1000）</h3>
              <ScoreGauge :score="result.score" :size="320" :max="1000" />
            </div>
          </el-col>

          <!-- 风险等级 & 违约概率 -->
          <el-col :xs="24" :md="8">
            <div class="info-card risk-card">
              <h3 class="card-title">风险等级</h3>
              <div class="risk-level-display">
                <RiskBadge :level="result.level" />
                <p class="risk-desc">
                  {{
                    result.level === '低风险'
                      ? '企业经营稳健，违约风险较低'
                      : result.level === '中等风险'
                        ? '需关注部分指标，审慎授信'
                        : '存在较高风险，建议暂缓放贷'
                  }}
                </p>
              </div>

              <el-divider />

              <div class="prob-section">
                <span class="prob-label">违约概率</span>
                <div class="prob-bar-wrapper">
                  <el-progress
                    :percentage="parseFloat(probabilityPercent)"
                    :color="result.probability > 0.3 ? '#f56c6c' : result.probability > 0.15 ? '#e6a23c' : '#67c23a'"
                    :stroke-width="14"
                  >
                    <span class="prob-text">{{ probabilityPercent }}%</span>
                  </el-progress>
                </div>
              </div>
            </div>
          </el-col>

          <!-- 授信建议 -->
          <el-col :xs="24" :md="8">
            <div class="info-card advice-card">
              <h3 class="card-title">授信建议</h3>
              <div class="advice-item">
                <span class="advice-label">建议额度</span>
                <span class="advice-value highlight">{{ result.suggestedAmount }} <small>万元</small></span>
              </div>
              <div class="advice-item">
                <span class="advice-label">建议利率</span>
                <span class="advice-value">{{ result.suggestedRate }}<small>%</small></span>
              </div>
              <el-divider />
              <p class="advice-text">{{ result.advice }}</p>
            </div>
          </el-col>
        </el-row>

        <div class="info-card ai-review-card">
          <h3 class="card-title">
            <el-icon style="vertical-align: middle; margin-right: 6px" color="#2c6e49"><Document /></el-icon>
            重点指标复核提示
          </h3>
          <p v-if="reviewStatusText" class="review-status" role="status">{{ reviewStatusText }}</p>
          <div v-if="aiReview?.status === 'pending' && !reviewRows.some((row) => row.streaming)" class="review-skeleton" aria-label="复核提示生成中">
            <div v-for="n in 2" :key="n" class="skeleton-line" />
          </div>
          <el-row :gutter="16">
            <el-col v-for="(row, idx) in reviewRows" :key="`${row.position}-${row.code}`" :xs="24" :sm="12" :md="8">
              <div class="deduction-item">
                <div class="deduction-rank">NO.{{ idx + 1 }}</div>
                <div class="deduction-body">
                  <div class="review-heading">
                    <div class="deduction-factor">{{ row.factor }}</div>
                    <el-tag v-if="row.generated" :disable-transitions="true" size="small" type="success" effect="plain">AI生成</el-tag>
                  </div>
                  <el-progress
                    :percentage="row.score"
                    :stroke-width="10"
                    :color="row.score >= 60 ? '#e6a23c' : '#f56c6c'"
                    :show-text="false"
                    style="margin: 8px 0"
                  />
                  <p class="deduction-reason">
                    <span :key="row.explanation" :class="{ 'review-explanation-streaming': row.streaming }">{{ row.explanation }}</span>
                    <span v-if="row.streaming" class="review-cursor" aria-hidden="true" />
                  </p>
                  <ul v-if="row.checks.length" class="review-checks"><li v-for="check in row.checks" :key="check">{{ check }}</li></ul>
                </div>
              </div>
            </el-col>
          </el-row>
          <p v-if="!reviewRows.length" class="review-fallback">{{ generalReviewText }}</p>
          <el-button
            v-if="aiReview?.status === 'not_requested' || (aiReview?.status === 'failed' && aiReview.retryable)"
            size="small"
            :disabled="retrySubmitting || retryCountdown > 0"
            @click="retryReview"
          >{{ retrySubmitting ? '正在提交…' : retryCountdown ? `${retryCountdown} 秒后可重试` : aiReview?.status === 'not_requested' ? '生成复核提示' : '重试生成' }}</el-button>
        </div>

        <!-- 因子贡献图 -->
        <div class="info-card chart-card">
          <h3 class="card-title">各指标得分贡献</h3>
          <div class="contribution-scroll">
            <div ref="barChartRef" class="contribution-chart" :style="{ minWidth: contributionMinWidth + 'px' }" />
          </div>
          <p class="scroll-hint">← 左右滑动查看全部指标 →</p>
        </div>

        <DataTransparency
          v-if="result.transparency"
          ref="transparencyRef"
          :transparency="result.transparency"
          :completeness="result.completeness"
          @supplement="supplementData"
        />

        <!-- 操作按钮 -->
        <div class="action-bar">
          <el-button @click="goBack">
            <el-icon><Back /></el-icon>
            重新评估
          </el-button>
          <el-button @click="showForm">
            <el-icon><Document /></el-icon>
            查看原始表单
          </el-button>
          <el-button v-if="activeAlerts.length" type="warning" plain @click="alertModalVisible = true">
            <el-icon><WarningFilled /></el-icon>
            复核风险提示
          </el-button>
          <el-button type="primary" @click="handlePrint">
            <el-icon><Printer /></el-icon>
            打印报告
          </el-button>
        </div>
      </template>

      <!-- 无数据占位 -->
      <div v-if="!result" class="no-result-wrap">
        <el-empty description="暂无评估结果，请先录入数据">
          <el-button type="primary" @click="router.push('/input')">前往录入</el-button>
        </el-empty>
      </div>

      <!-- 历史评估记录（当前账号） -->
      <div class="info-card history-card">
        <h3 class="card-title">
          <el-icon style="vertical-align: middle; margin-right: 6px" color="#2c6e49"><Clock /></el-icon>
          历史评估记录
          <el-tag size="small" type="info" effect="plain" style="margin-left: 8px"
            >当前账号 · {{ historyTotal }} 条</el-tag
          >
        </h3>
        <div class="table-scroll">
          <el-table
            v-loading="historyLoading"
            :data="historyRecords"
            size="small"
            stripe
            empty-text="暂无历史评估记录"
            style="min-width: 840px"
          >
            <el-table-column prop="enterpriseName" label="企业名称" min-width="150" show-overflow-tooltip />
            <el-table-column label="评分" width="72" align="center">
              <template #default="{ row }">
                <span
                  class="history-score"
                  :style="{ color: row.score >= 700 ? '#67c23a' : row.score >= 500 ? '#e6a23c' : '#f56c6c' }"
                >
                  {{ row.score }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="风险等级" width="140" align="center">
              <template #default="{ row }">
                <RiskBadge :level="row.level" />
              </template>
            </el-table-column>
            <el-table-column label="评估时间" width="150">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="回填结果" width="110" align="center">
              <template #default="{ row }">
                <el-tag :type="outcomeOption(row.outcome).type" size="small">
                  {{ outcomeOption(row.outcome).label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" align="center" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="viewHistory(row.id)">查看</el-button>
                <el-button link type="warning" @click="openOutcome(row)">回填</el-button>
                <el-button link type="danger" @click="removeHistory(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <div v-if="historyTotal > historySize" class="history-pager">
          <el-pagination
            layout="prev, pager, next"
            :total="historyTotal"
            :page-size="historySize"
            :current-page="historyPage"
            background
            size="small"
            @current-change="loadHistory"
          />
        </div>
      </div>
    </div>

    <RiskAlertModal v-model="alertModalVisible" :alerts="activeAlerts" @view="jumpToIndicator" />

    <el-dialog
      v-model="outcomeVisible"
      title="回填真实结果"
      width="min(420px, 92vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!outcomeSaving"
      :show-close="!outcomeSaving"
      append-to-body
    >
      <el-form label-width="90px" :disabled="outcomeSaving">
        <el-form-item label="企业名称">
          <span>{{ outcomeForm.enterpriseName }}</span>
        </el-form-item>
        <el-form-item label="真实结果">
          <el-select v-model="outcomeForm.outcome" style="width: 100%">
            <el-option
              v-for="option in OUTCOME_OPTIONS"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="outcomeForm.note"
            type="textarea"
            :rows="3"
            maxlength="255"
            show-word-limit
            placeholder="如：实际放款后 6 个月出现逾期"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="outcomeSaving" @click="outcomeVisible = false">取消</el-button>
        <el-button type="primary" :loading="outcomeSaving" @click="saveOutcome">保存</el-button>
      </template>
    </el-dialog>

    <!-- 原始表单抽屉 -->
    <el-drawer v-model="formDrawerVisible" title="评估原始表单" size="min(640px, 92%)">
      <el-table v-if="formRows.length" :data="formRows" size="small" border stripe>
        <el-table-column prop="level" label="层级" width="120" />
        <el-table-column prop="name" label="指标名称" min-width="200" />
        <el-table-column prop="unit" label="单位" width="80" />
        <el-table-column prop="value" label="填写值" min-width="120" />
      </el-table>
      <el-empty v-else description="该评估没有已填写的指标数据" :image-size="80" />
    </el-drawer>

    <!-- 正式打印报告（仅打印时显示） -->
    <div v-if="result" class="print-report">
      <div class="pr-header">
        <h1>涉农小微企业信贷风险评估报告</h1>
        <p class="pr-meta">
          报告编号：{{ reportNo }} ｜ 评估时间：{{ printDate }} ｜ 系统：{{ APP_FULL_NAME }} Demo v{{ APP_VERSION }}
        </p>
      </div>

      <div class="pr-basic">
        <table>
          <tbody>
            <tr>
              <th>企业名称</th>
              <td>{{ reportTitle }}</td>
              <th>经营类型</th>
              <td>{{ businessTypeText }}</td>
            </tr>
            <tr>
              <th>综合信用评分</th>
              <td>{{ result.score }} 分（0-1000）</td>
              <th>风险等级</th>
              <td>{{ result.level }}</td>
            </tr>
            <tr>
              <th>违约概率</th>
              <td>{{ probabilityPercent }}%</td>
              <th>数据完整度</th>
              <td>{{ completenessText }}</td>
            </tr>
            <tr>
              <th>建议授信额度</th>
              <td>{{ result.suggestedAmount }} 万元</td>
              <th>建议利率</th>
              <td>{{ result.suggestedRate }}%</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>一、授信建议</h2>
      <p class="pr-advice">{{ result.advice }}</p>

      <h2>二、主要指标得分表现</h2>
      <table class="pr-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>指标</th>
            <th>所属层级</th>
            <th>得分（0-100）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in sortedContribs" :key="i">
            <td class="pr-c">{{ i + 1 }}</td>
            <td>{{ c.factor }}</td>
            <td class="pr-c">{{ c.category }}</td>
            <td class="pr-c">{{ c.score.toFixed(1) }}</td>
          </tr>
        </tbody>
      </table>

      <h2>三、重点指标复核提示</h2>
      <p v-if="aiReview?.status === 'pending'">复核提示正在生成中，当前报告暂不包含生成内容。</p>
      <ol v-if="printReviewRows.length" class="pr-deductions">
        <li v-for="row in printReviewRows" :key="`${row.position}-${row.code}`">
          <strong>{{ row.factor }}（得分 {{ row.score }}<template v-if="row.code">，{{ row.code }}</template>）</strong>
          <el-tag v-if="row.generated" size="small" type="success" effect="plain">AI生成</el-tag>：{{ row.explanation }}
          <ul v-if="row.checks.length"><li v-for="check in row.checks" :key="check">{{ check }}</li></ul>
        </li>
      </ol>
      <p v-else>{{ generalReviewText }}</p>

      <div class="pr-footer">
        <p>
          本报告由涉农信贷风险智能评估系统基于替代数据指标体系与专家引擎自动生成，仅供信贷审批参考，不构成授信承诺。
        </p>
        <div class="pr-sign">
          <span>信贷员签字：______________</span>
          <span>复核人签字：______________</span>
          <span>日期：____________________</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.result-cards {
  margin-bottom: 20px;

  // 移动端卡片堆叠时保留纵向间距
  .el-col {
    margin-bottom: 16px;
  }
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid #f0f0f0;
}

.gauge-card {
  text-align: center;
}

.risk-card {
  .risk-level-display {
    text-align: center;
    padding: 16px 0;

    .risk-desc {
      margin-top: 12px;
      font-size: 13px;
      color: #909399;
    }
  }

  .prob-section {
    .prob-label {
      font-size: 13px;
      color: #606266;
      display: block;
      margin-bottom: 10px;
    }

    .prob-bar-wrapper {
      .prob-text {
        font-size: 14px;
        font-weight: 600;
      }
    }
  }
}

.advice-card {
  .advice-item {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 12px;

    .advice-label {
      font-size: 14px;
      color: #606266;
    }

    .advice-value {
      font-size: 22px;
      font-weight: 700;
      color: #303133;

      small {
        font-size: 13px;
        font-weight: 400;
        color: #909399;
      }

      &.highlight {
        color: #2c6e49;
      }
    }
  }

  .advice-text {
    font-size: 13px;
    color: #606266;
    line-height: 1.8;
  }
}

.chart-card {
  margin-bottom: 20px;
}

.ai-review-card {
  margin-bottom: 20px;

  .review-status {
    color: #909399;
    font-size: 13px;
  }

  .el-row .el-col { margin-bottom: 16px; }

  .deduction-item {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 16px;
    border-radius: 10px;
    background: #fafafa;
    height: 100%;

    .deduction-rank {
      flex-shrink: 0;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: #f56c6c;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .deduction-body {
      flex: 1;
      min-width: 0;

      .review-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .deduction-factor {
        font-size: 14px;
        font-weight: 600;
        color: #303133;
      }

      .deduction-reason {
        font-size: 12px;
        color: #606266;
        line-height: 1.6;
        margin: 8px 0 0;
      }

      .review-checks {
        margin: 8px 0 0;
        padding-left: 20px;
        color: #606266;
        font-size: 12px;
        line-height: 1.6;
      }
    }
  }

  .review-explanation-streaming { animation: review-appear 150ms ease-out both; }

  .review-cursor {
    display: inline-block;
    width: 1px;
    height: 1em;
    margin-left: 2px;
    vertical-align: text-bottom;
    background: #2c6e49;
    animation: review-cursor-blink 900ms steps(2, start) infinite;
  }

  .review-fallback {
    padding: 10px 14px;
    border-radius: 6px;
    background: #f7f8f7;
    color: #606266;
    font-size: 13px;
    line-height: 1.7;
  }

  .review-fallback p { margin: 0; }

  .review-skeleton .skeleton-line {
    height: 14px;
    margin: 12px 0;
    border-radius: 7px;
    background: linear-gradient(90deg, #f1f3f2 25%, #e7ebe8 50%, #f1f3f2 75%);
    background-size: 200% 100%;
    animation: review-shimmer 1.4s linear infinite, review-fade 1.2s ease-in-out infinite alternate;
  }

  .review-skeleton .skeleton-line:last-child { width: 72%; }
}

@keyframes review-appear {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes review-shimmer {
  to { background-position: -200% 0; }
}

@keyframes review-fade {
  to { opacity: 0.52; }
}

@keyframes review-cursor-blink {
  to { visibility: hidden; }
}

@media (prefers-reduced-motion: reduce) {
  .ai-review-card .review-explanation-streaming,
  .ai-review-card .review-skeleton .skeleton-line,
  .ai-review-card .review-cursor { animation: none; }
}

// 贡献图：移动端横向滑动，避免因子名称占满左侧
.contribution-scroll {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;

  .contribution-chart {
    width: 100%;
    height: 320px;
  }
}

.scroll-hint {
  display: none;
}

@media (max-width: 768px) {
  .scroll-hint {
    display: block;
    text-align: center;
    font-size: 12px;
    color: #909399;
    margin-top: 8px;
  }
}

.action-bar {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-top: 8px;
}

.no-result-wrap {
  padding: 40px 0;
}

.history-card {
  margin-top: 20px;

  .history-score {
    font-weight: 700;
    font-size: 15px;
  }

  .history-pager {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }

  // 历史记录表格：窄屏时横向滚动，避免列被压缩（风险等级/时间显示不全）
  .table-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;

    :deep(.el-table) {
      width: 100%;
    }
  }
}

/* ---------- 打印报告样式 ---------- */
.print-report {
  display: none;
}

@media print {
  :global(.app-aside),
  :global(.app-header),
  :global(.app-footer) {
    display: none !important;
  }

  :global(.app-main) {
    padding: 0 !important;
    background: #fff !important;
    overflow: visible !important;
  }

  // 打印只输出正式报告，隐藏页面本体（含历史评估记录、操作栏）
  .page-container,
  .no-result-wrap,
  .history-card {
    display: none !important;
  }

  .print-report {
    display: block;
    font-family: 'Microsoft YaHei', 'PingFang SC', 'SimSun', sans-serif;
    color: #000;
    font-size: 13px;
    line-height: 1.8;

    .pr-header {
      text-align: center;
      border-bottom: 3px double #333;
      padding-bottom: 12px;
      margin-bottom: 16px;

      h1 {
        font-size: 24px;
        letter-spacing: 4px;
        margin: 0 0 8px;
        color: #000;
      }

      .pr-meta {
        font-size: 11px;
        color: #333;
        margin: 0;
      }
    }

    .pr-basic {
      margin-bottom: 16px;

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        border: 1px solid #999;
        padding: 7px 10px;
        font-size: 13px;
      }

      th {
        width: 92px;
        text-align: center;
        background: #f2f2f2;
        font-weight: 600;
      }
    }

    h2 {
      font-size: 15px;
      margin: 16px 0 8px;
      padding-left: 8px;
      border-left: 4px solid #2c6e49;
    }

    .pr-advice {
      padding: 8px 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
    }

    .pr-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;

      th,
      td {
        border: 1px solid #999;
        padding: 5px 8px;
        text-align: left;
      }

      th {
        background: #f2f2f2;
      }

      .pr-c {
        text-align: center;
      }
    }

    .pr-deductions {
      margin: 0;
      padding-left: 24px;
    }

    .pr-footer {
      margin-top: 26px;
      font-size: 11px;
      color: #333;

      p {
        margin: 0 0 22px;
      }

      .pr-sign {
        display: flex;
        justify-content: space-between;
      }
    }
  }
}
</style>
