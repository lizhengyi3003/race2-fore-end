import http from './index'
import type { AIReview, AssessmentOutcome, AssessmentRecordDetail, AssessmentRecordItem, DynamicRiskInput, PageData, RiskResult } from './types'
import { apiBaseURL, handleAuthExpired } from './index'
import { TOKEN_KEY } from '@/constants'

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
export async function getRiskRecord(recordId: number, signal?: AbortSignal): Promise<AssessmentRecordDetail> {
  return http.get<AssessmentRecordDetail>(`/risk/records/${recordId}`, signal ? { signal } : undefined)
}

export async function getRiskReview(recordId: number, signal?: AbortSignal): Promise<AIReview> {
  return http.get<AIReview>(`/risk/records/${recordId}/review`, signal ? { signal } : undefined)
}

export async function requestRiskReview(recordId: number): Promise<AIReview> {
  return http.post<AIReview>(`/risk/records/${recordId}/review`)
}

export async function openRiskReviewStream(recordId: number, signal: AbortSignal): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY)
  const response = await fetch(`${apiBaseURL}/risk/records/${recordId}/review/stream`, {
    headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal,
  })
  if (response.status === 401) {
    handleAuthExpired('登录已过期，请重新登录')
    throw Object.assign(new Error('登录已过期，请重新登录'), { code: 401 })
  }
  if (!response.ok) throw Object.assign(new Error(`复核状态连接失败（${response.status}）`), { code: response.status })
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    const body = await response.json().catch(() => null) as { code?: number; message?: string } | null
    if (body?.code === 401) handleAuthExpired(body.message || '登录已过期，请重新登录')
    throw Object.assign(new Error(body?.message || '复核状态流不可用'), { code: body?.code ?? response.status })
  }
  if (!response.body) throw new Error('浏览器不支持复核状态流')
  return response
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
