import http from './index'
import type {
  AssessmentOutcome,
  AssessmentRecordDetail,
  AssessmentRecordItem,
  DynamicRiskInput,
  PageData,
  RiskResult,
} from './types'

/**
 * 动态指标体系评估（专家引擎）：POST /api/v1/risk/assess-dynamic
 */
export async function submitDynamicRiskAssessment(data: DynamicRiskInput): Promise<RiskResult> {
  return http.post<RiskResult>('/risk/assess-dynamic', data)
}

/** 历史评估记录分页（仅当前账号）：GET /risk/records */
export async function getRiskRecords(params: {
  page?: number
  size?: number
}): Promise<PageData<AssessmentRecordItem>> {
  return http.get<PageData<AssessmentRecordItem>>('/risk/records', { params })
}

/** 历史评估记录详情：GET /risk/records/{id} */
export async function getRiskRecord(recordId: number): Promise<AssessmentRecordDetail> {
  return http.get<AssessmentRecordDetail>(`/risk/records/${recordId}`)
}

/** 删除历史评估记录：DELETE /risk/records/{id} */
export async function deleteRiskRecord(recordId: number): Promise<void> {
  return http.delete(`/risk/records/${recordId}`)
}

/** 回填本人评估记录的真实结果；管理员同时可维护其他记录 */
export async function updateRiskRecordOutcome(
  recordId: number,
  body: { outcome: AssessmentOutcome; note?: string }
): Promise<AssessmentRecordItem> {
  return http.put<AssessmentRecordItem>(`/risk/records/${recordId}/outcome`, body)
}
