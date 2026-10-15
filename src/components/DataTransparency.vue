<script setup lang="ts">
import { computed } from 'vue'
import type { RiskTransparency } from '@/api/types'

const props = defineProps<{ transparency: RiskTransparency; completeness?: number }>()
const emit = defineEmits<{ (e: 'supplement', code?: string): void }>()
const needsSupplement = computed(() =>
  props.transparency.indicators.some((item) => item.status === 'missing' || item.status === 'invalid')
)

function statusLabel(status: string): string {
  return (
    ({ provided: '已填写', missing: '缺失', invalid: '待修正', unscored: '未计分' } as Record<string, string>)[
      status
    ] || status
  )
}

function statusType(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'provided') return 'success'
  if (status === 'missing' || status === 'invalid') return 'danger'
  return 'info'
}

function scrollToIndicator(code: string) {
  if (!code) return
  document.getElementById(`indicator-${code}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

defineExpose({ scrollToIndicator })
</script>

<template>
  <section id="data-transparency" class="transparency-card info-card">
    <div class="heading-row">
      <div>
        <h3 class="card-title">数据来源与评估依据</h3>
        <p class="intro">逐项展示评估数据来源、用途和评分规则，方便核对本次结果依据。</p>
      </div>
      <el-button v-if="needsSupplement" type="primary" plain @click="emit('supplement')">
        补录缺失或无效数据
      </el-button>
    </div>

    <div class="coverage-grid">
      <div class="coverage-stat">
        <span>应评估指标</span><strong>{{ transparency.expectedCount }}</strong>
      </div>
      <div class="coverage-stat">
        <span>有值项目（含无效）</span><strong>{{ transparency.providedCount }}</strong>
      </div>
      <div class="coverage-stat">
        <span>已计分</span><strong>{{ transparency.scoredCount }}</strong>
      </div>
      <div class="coverage-stat">
        <span>原始填报完整度</span
        ><strong>{{ completeness == null ? '—' : `${(completeness * 100).toFixed(0)}%` }}</strong>
      </div>
      <div class="coverage-stat confidence-stat">
        <span>有效数据覆盖率</span><strong>{{ (transparency.confidence * 100).toFixed(0) }}%</strong>
      </div>
    </div>
    <el-progress
      :percentage="Math.max(0, Math.min(100, transparency.confidence * 100))"
      :show-text="false"
      :stroke-width="10"
      color="#4c956c"
    />
    <p class="confidence-note">
      <strong>{{ transparency.confidenceLabel }}</strong> · {{ transparency.confidenceExplanation }}
      <el-tooltip
        content="补充更多与主体相关且有效的信息，可减少缺失对评估的影响，让本次结果建立在更充分的数据基础上。此提示不代表预测准确率已获统计验证。"
        placement="top"
      >
        <el-icon class="info-icon"><InfoFilled /></el-icon>
      </el-tooltip>
    </p>
    <p class="accuracy-note">
      原始填报完整度统计有值项目；有效数据覆盖率统计可用于评估的有效指标，两者含义不同。覆盖率不代表模型预测准确率或经统计验证的准确率。
    </p>

    <div class="indicator-list">
      <article
        v-for="item in transparency.indicators"
        :id="`indicator-${item.code}`"
        :key="item.code"
        class="indicator-row"
        :class="{ 'is-missing': item.status === 'missing' || item.status === 'invalid' }"
      >
        <div class="indicator-head">
          <div>
            <strong>{{ item.name }}</strong
            ><span class="indicator-code">{{ item.code }} · {{ item.level }}</span>
          </div>
          <el-tag :type="statusType(item.status)" effect="plain" size="small">{{ statusLabel(item.status) }}</el-tag>
        </div>
        <div class="indicator-facts">
          <span
            >本次值：{{ item.value ?? '未填写'
            }}<template v-if="item.unit && item.unit !== '—'"> {{ item.unit }}</template></span
          >
          <span>数据来源：{{ item.dataSource || '未配置' }}</span>
          <span>评分：{{ item.score == null ? '未计分' : `${item.score} 分` }}</span>
          <span>计分权重：{{ item.weight == null ? '未参与计分' : `${(item.weight * 100).toFixed(1)}%` }}</span>
        </div>
        <p><b>评分用途 / 风险含义：</b>{{ item.riskMeaning || '未配置' }}</p>
        <p><b>评分规则：</b>{{ item.scoringRule || '未配置' }}</p>
        <el-button v-if="item.code" link type="primary" @click="scrollToIndicator(item.code)">定位指标</el-button>
        <el-button
          v-if="item.status === 'missing' || item.status === 'invalid'"
          link
          type="danger"
          @click="emit('supplement', item.code)"
        >
          去补录此项
        </el-button>
      </article>
    </div>
  </section>
</template>

<style scoped lang="scss">
.transparency-card {
  margin-bottom: 20px;
  scroll-margin-top: 24px;
}
.heading-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.card-title {
  margin: 0 0 8px;
  font-size: 16px;
}
.intro,
.accuracy-note,
.confidence-note {
  color: #606266;
  font-size: 13px;
  line-height: 1.6;
}
.intro {
  margin: 0 0 16px;
}
.accuracy-note {
  color: #909399;
  margin: 4px 0 18px;
}
.confidence-note {
  margin: 10px 0 0;
}
.coverage-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.coverage-stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border-radius: 8px;
  background: #f5f7fa;
  color: #606266;
  font-size: 12px;
}
.coverage-stat strong {
  color: #303133;
  font-size: 20px;
}
.confidence-stat strong {
  color: #2c6e49;
}
.info-icon {
  margin-left: 5px;
  color: #409eff;
  cursor: help;
  vertical-align: middle;
}
.indicator-list {
  display: grid;
  gap: 12px;
  margin-top: 18px;
}
.indicator-row {
  padding: 16px;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  scroll-margin-top: 24px;
}
.indicator-row.is-missing {
  border-color: #f3b8b8;
  background: #fffafa;
}
.indicator-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.indicator-head strong {
  display: block;
  color: #303133;
}
.indicator-code {
  display: block;
  margin-top: 4px;
  color: #909399;
  font-size: 12px;
}
.indicator-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin: 12px 0;
  color: #606266;
  font-size: 13px;
}
.indicator-row p {
  margin: 7px 0;
  color: #606266;
  font-size: 13px;
  line-height: 1.6;
}
@media (max-width: 640px) {
  .heading-row {
    flex-direction: column;
  }
  .coverage-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
