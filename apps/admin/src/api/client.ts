const API_BASE = import.meta.env.VITE_API_BASE_URL || '/v1'
export const adminDemoMode = import.meta.env.VITE_DEMO_MODE === 'true'
export const adminSession = { get: () => sessionStorage.getItem('telebirr_admin_session'), set: (token: string) => sessionStorage.setItem('telebirr_admin_session', token), clear: () => sessionStorage.removeItem('telebirr_admin_session') }

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(adminSession.get() ? { authorization: `Bearer ${adminSession.get()}` } : {}), ...init?.headers },
  })
  const body = await response.json().catch(() => ({ message: `Platform API request failed (${response.status})` }))
  if (!response.ok) throw new ApiError(response.status, String(body.message ?? `Platform API request failed (${response.status})`))
  return (body.data ?? body) as T
}

export async function passwordReauthenticate(password: string): Promise<string> {
  const result = await api<{ reauth_token: string }>('/admin/auth/reauthenticate', { method: 'POST', body: JSON.stringify({ password }) })
  return result.reauth_token
}

export async function sensitiveApi<T>(path: string, reauthToken: string, init?: RequestInit): Promise<T> {
  return api<T>(path, { ...init, headers: { 'x-reauth-token': reauthToken, ...init?.headers } })
}
