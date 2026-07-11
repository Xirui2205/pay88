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
  sims: SimWallet[]
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
}
