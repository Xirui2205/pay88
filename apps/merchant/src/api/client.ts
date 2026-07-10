const API_BASE=import.meta.env.VITE_API_BASE_URL||'/v1'
export const merchantDemoMode=import.meta.env.VITE_DEMO_MODE==='true'
export const merchantSession={get:()=>sessionStorage.getItem('telebirr_merchant_session'),set:(token:string)=>sessionStorage.setItem('telebirr_merchant_session',token),clear:()=>sessionStorage.removeItem('telebirr_merchant_session')}
export class MerchantApiError extends Error{constructor(public status:number,public code:string,message:string){super(message)}}
export async function merchantApi<T>(path:string,init?:RequestInit):Promise<T>{
  const token=merchantSession.get()
  const response=await fetch(`${API_BASE}${path}`,{...init,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...init?.headers}})
  const body=await response.json().catch(()=>({message:`Merchant API request failed (${response.status})`,code:'invalid_response'}))
  if(!response.ok)throw new MerchantApiError(response.status,String(body.code??'request_failed'),String(body.message??`Merchant API request failed (${response.status})`))
  return (body.data??body) as T
}
