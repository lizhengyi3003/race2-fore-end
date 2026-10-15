<script setup lang="ts">
import { computed } from 'vue'
import type { RiskAlert } from '@/api/types'

const props = defineProps<{ modelValue: boolean; alerts: RiskAlert[] }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'view', code: string): void
}>()

const vetoAlerts = computed(() => props.alerts.filter((alert) => alert.severity === 'veto'))
const highAlerts = computed(() => props.alerts.filter((alert) => alert.severity === 'high'))

function view(code: string) {
  emit('update:modelValue', false)
  emit('view', code)
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="风险提示"
    width="min(560px, 92vw)"
    :class="{ 'has-veto': vetoAlerts.length > 0, 'has-high': !vetoAlerts.length && highAlerts.length > 0 }"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="vetoAlerts.length" class="alert-group veto-group">
      <div class="group-title">
        <el-icon><CircleCloseFilled /></el-icon> 一票否决命中
      </div>
      <div v-for="(alert, index) in vetoAlerts" :key="`veto-${alert.code}-${index}`" class="alert-item">
        <strong>{{ alert.factor || '系统风险规则' }}</strong>
        <span v-if="alert.score != null" class="alert-score">指标得分：{{ alert.score }} 分</span>
        <p>{{ alert.reason }}</p>
        <el-button link type="danger" @click="view(alert.code)">查看对应指标</el-button>
      </div>
    </div>
    <div v-if="highAlerts.length" class="alert-group high-group">
      <div class="group-title">
        <el-icon><WarningFilled /></el-icon> 高风险指标
      </div>
      <div v-for="(alert, index) in highAlerts" :key="`high-${alert.code}-${index}`" class="alert-item">
        <strong>{{ alert.factor || '系统风险规则' }}</strong>
        <span v-if="alert.score != null" class="alert-score">指标得分：{{ alert.score }} 分</span>
        <p>{{ alert.reason }}</p>
        <el-button link type="warning" @click="view(alert.code)">查看对应指标</el-button>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">知道了</el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.alert-group {
  padding: 14px 16px;
  border-radius: 8px;
  & + .alert-group {
    margin-top: 12px;
  }
  p {
    margin: 8px 0 4px;
    line-height: 1.6;
  }
}
.veto-group {
  background: #fef0f0;
  border: 1px solid #fbc4c4;
  color: #a8071a;
}
.high-group {
  background: #fdf6ec;
  border: 1px solid #f5dab1;
  color: #a45b00;
}
.group-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
}
.alert-item {
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px solid currentColor;
  border-color: rgb(0 0 0 / 8%);
}
.alert-score {
  margin-left: 10px;
  font-size: 12px;
  opacity: 0.8;
}
:deep(.has-veto .el-dialog__header) {
  border-bottom: 3px solid #f56c6c;
}
:deep(.has-high .el-dialog__header) {
  border-bottom: 3px solid #e6a23c;
}
</style>
