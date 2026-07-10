import {defineStore} from 'pinia'
import {ref} from 'vue'

export const useCheckoutSessionStore=defineStore('checkout-session',()=>{
  const kind=ref<'deposit'|'withdrawal'>('deposit')
  const reference=ref('')
  const startedAt=ref(0)
  function begin(nextKind:'deposit'|'withdrawal',nextReference:string){kind.value=nextKind;reference.value=nextReference;startedAt.value=Date.now()}
  return{kind,reference,startedAt,begin}
})
