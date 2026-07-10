export function formatEtb(value: string | number): string {
  const amount=typeof value==='number'?value:Number(value)
  if(!Number.isFinite(amount)) throw new Error('Invalid ETB amount')
  return new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(amount)
}
export function secondsRemaining(expiresAt:string|number|Date,now=Date.now()):number{return Math.max(0,Math.ceil((new Date(expiresAt).getTime()-now)/1000))}
export function clock(seconds:number):string{const value=Math.max(0,Math.floor(seconds));return `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`}
export function normalizePhone(value:string):string{return value.replace(/\D/g,'').replace(/^251/,'0')}
