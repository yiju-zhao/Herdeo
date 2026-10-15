import {createHash} from 'node:crypto';

interface Receipt {
 id:string; hash:string; turnId?:string; status:'reserved'|'accepted'|'delivered'|'uncertain';
 result:Promise<{turnId:string}>;
}

/** The native host owns deduplication, so replacing a Paseo view cannot repeat a send. */
export class PromptDelivery {
 private receipts=new Map<string,Receipt>();
 snapshot(){return [...this.receipts.values()].filter(r=>r.turnId).map(({result,...receipt})=>receipt);}
 deliver(id:string,text:string,send:(accept:(turnId:string)=>void)=>Promise<{turnId:string}>):Promise<{turnId:string}>{
  if(typeof id!=='string'||!id.length||id.length>256||typeof text!=='string'||!text.trim())return Promise.reject(Error('A native message requires text and a valid client message ID'));
  const hash=createHash('sha256').update(text).digest('hex'),previous=this.receipts.get(id);
  if(previous)return previous.hash===hash?previous.result:Promise.reject(Error('This message ID was already used for different text'));
  const receipt:Receipt={id,hash,status:'reserved',result:Promise.resolve({turnId:''})};
  this.receipts.set(id,receipt);
  receipt.result=Promise.resolve().then(()=>send(turnId=>{receipt.turnId=turnId;receipt.status='accepted';})).then(result=>{
   receipt.status='delivered';return result;
  },error=>{
   // Busy/startup failures have not reached the executor and can be retried.
   // Once accepted, an uncertain transport acknowledgement must never resend.
   if(!receipt.turnId)this.receipts.delete(id);else receipt.status='uncertain';
   throw error;
  });
  return receipt.result;
 }
}
