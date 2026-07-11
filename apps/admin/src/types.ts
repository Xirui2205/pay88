export type Health = 'healthy' | 'warning' | 'offline' | 'quarantined'
export type JobStatus = 'queued' | 'assigned' | 'running' | 'success' | 'failed' | 'unknown'

export interface SimWallet {
  id: string
  slot: 1 | 2
  phone: string
  accountName: string
  balance: number
  balanceAge: number
  dailyUsed: number
  dailyLimit: number
  health: Health
}

export interface Device {
  id: string
  status: string
  name: string
  model: string
  location: string
  group: string
  health: Health
  lastSeen: string
  battery: number
  temperature: number
  appVersion: string
  profileVersion: string
  permissionsOk: boolean
  accessibilityOk: boolean
  credentialsConfigured?: boolean
  socketConnected?: boolean
  lastHelloAt?: string | null
  disconnectReason?: string | null
  readiness: DeviceReadiness
  lastProfileInstallResult: unknown
  sims: SimWallet[]
}

export interface DeviceBlocker {
  code: string
  message: string
  detail?: unknown
}

export interface DeviceReadiness {
  ready: boolean
  heartbeat_age_seconds: number | null
  permissions_ok: boolean
  accessibility_ok: boolean
  installed_profiles: string[]
  required_profiles: string[]
  missing_profiles: string[]
  active_ussd_job_id: string | null
  blockers: DeviceBlocker[]
}

export interface OperationRecord {
  id: string
  merchant: string
  reference: string
  customer: string
  amount: number
  status: string
  p2pStatus: string
  age: string
  device?: string
  log?: Array<{ at: string; event: string; detail: string }>
  canExecuteNow?: boolean
  canRetry?: boolean
  readiness?: DeviceReadiness
}
