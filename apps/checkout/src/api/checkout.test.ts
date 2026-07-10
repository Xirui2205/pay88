import {describe,expect,it} from 'vitest'
import {mapHostedDeposit} from './checkout'

describe('hosted checkout adapter',()=>{
  it('maps the public snake-case API without exposing merchant credentials',()=>{
    const result=mapHostedDeposit({tx_ref:'AB-1',amount:'500.00',credited_amount:null,currency:'ETB',p2p_status:'awaiting_payment',assigned_phone_number:'0992844697',receiver_name:'Abayine Fucha',expires_at:'2026-07-10T08:10:00.000Z',late_grace_ends_at:'2026-07-10T08:40:00.000Z',countdown_seconds:600,late_grace_seconds:1800,return_url:'https://merchant.example/return',merchant_name:'AsterBet'},'scoped-token')
    expect(result.reference).toBe('AB-1')
    expect(result.receiverPhone).toBe('0992844697')
    expect(result.merchantName).toBe('AsterBet')
    expect(result.token).toBe('scoped-token')
  })
})
