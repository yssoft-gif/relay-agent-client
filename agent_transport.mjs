// Node 22+ transport for RELAY's wallet-authenticated encrypted agent API.
// Only Node builtins are used. No plaintext business API fallback exists.
import { webcrypto, randomUUID } from 'node:crypto';
const { subtle }=webcrypto;
const encoder=new TextEncoder();
const PROTOCOL='relay-agent/1',NETWORK='mainnet';
const MAX_REQUEST_BYTES=50000,MAX_RESPONSE_BYTES=2000000;
export class AgentTransportError extends Error {
 constructor(message,status=0){super(message);this.name='AgentTransportError';this.status=status;}
}
const fail=(message,status=0)=>{throw new AgentTransportError(message,status);};
const plainObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(plainObject(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function base64(bytes){return Buffer.from(bytes).toString('base64');}
function unbase64(value,min,max,label){
 if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||value.length%4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail(`Invalid ${label}`);
 const bytes=Buffer.from(value,'base64');if(bytes.length<min||bytes.length>max||bytes.toString('base64')!==value)fail(`Invalid ${label}`);return new Uint8Array(bytes);
}
function siteOrigin(value){
 let url;try{url=new URL(value);}catch{fail('A valid Site origin is required');}
 const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))fail('HTTPS is required except for loopback development');
 if(url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))fail('Site must be an origin without credentials, path or query');return url.origin;
}
export function requestAAD(origin,session_id,request_id){return encoder.encode(JSON.stringify({domain:'relay-agent-request/v1',network:NETWORK,origin,session_id,request_id}));}
export function responseAAD(origin,session_id,request_id,status){return encoder.encode(JSON.stringify({domain:'relay-agent-response/v1',network:NETWORK,origin,session_id,request_id,status}));}
export function sessionKeyLabel(origin,session_id,wallet,expires_at){return encoder.encode(`relay-agent-session-key/v1|${origin}|${session_id}|${wallet}|${expires_at}`);}
async function readJson(response,maxBytes){
 const reader=response.body?.getReader();if(!reader)fail('Empty encrypted API response');let size=0;const chunks=[];
 while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>maxBytes){await reader.cancel();fail('Encrypted API response exceeds the size limit');}chunks.push(item.value);}
 let json;try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Encrypted API returned malformed JSON');}
 if(!plainObject(json))fail('Encrypted API returned a non-object envelope');return json;
}
/**
 * signPayload(logicalBody) must return that exact body plus a fresh wallet auth
 * proof. It may use a local wallet; this module never receives a private seed.
 * exchange(payload) returns authenticated {status,result}. HTTP200 is the sealed
 * transport status; status inside the authenticated envelope is the application
 * status. close() drops references to session material and prevents further use.
 */
export async function createAgentTransport({site,wallet,signPayload,serviceToken='',fetchImpl=globalThis.fetch,now=Date.now}={}){
 const origin=siteOrigin(site);
 if(typeof wallet!=='string'||!/^G[A-Z2-7]{55}$/.test(wallet)||typeof signPayload!=='function'||typeof fetchImpl!=='function')fail('A public wallet and local signing callback are required');
 if(typeof serviceToken!=='string')fail('Invalid service access configuration');
 const headers={'Content-Type':'application/json','Accept':'application/json'};
 if(serviceToken)headers['OAI-Sites-Authorization']='Bearer '+serviceToken;
 let closed=false,key=null,pair=null;const seenIVs=new Set(),seenIds=new Set();let queue=Promise.resolve();
 function close(){closed=true;key=null;pair=null;seenIVs.clear();seenIds.clear();}
 async function post(path,body,maxBytes){
  let response;try{response=await fetchImpl(origin+path,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{fail('Encrypted API request status is uncertain; no plaintext retry was attempted');}
  if(!response.ok)fail(`Encrypted API rejected transport access (HTTP ${response.status})`,response.status);
  return readJson(response,maxBytes);
 }
 try{
  pair=await subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
  const public_key=await subtle.exportKey('jwk',pair.publicKey);
  const unsigned={action:'create_agent_session',wallet,public_key};
  const signed=await signPayload(unsigned);
  if(!plainObject(signed)||!plainObject(signed.auth)||signed.auth.wallet!==wallet)fail('Session signer returned invalid ownership proof');
  const unchanged={...signed};delete unchanged.auth;
  if(JSON.stringify(canonical(unchanged))!==JSON.stringify(canonical(unsigned)))fail('Session signer changed the public session request');
  const session=await post('/api/agent/session',signed,100000);
  if(session.protocol!==PROTOCOL||session.network!==NETWORK||session.wallet!==wallet||typeof session.session_id!=='string'||session.session_id.length<16||session.session_id.length>200||!Number.isSafeInteger(session.expires_at))fail('Encrypted API session metadata does not match this client');
  const seconds=Math.floor(now()/1000);
  if(session.expires_at<=seconds||session.expires_at>seconds+3630)fail('Encrypted API session expiry is invalid');
  const wrapped=unbase64(session.wrapped_session_key,256,256,'wrapped session key');
  let raw;try{raw=new Uint8Array(await subtle.decrypt({name:'RSA-OAEP',label:sessionKeyLabel(origin,session.session_id,wallet,session.expires_at)},pair.privateKey,wrapped));}catch{fail('Cannot unwrap the authenticated session key');}
  if(raw.length!==32){raw.fill(0);fail('Invalid session key length');}
  try{key=await subtle.importKey('raw',raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}finally{raw.fill(0);pair=null;}
  async function perform(payload){
   if(closed||!key)fail('Encrypted agent session is closed');
   if(Math.floor(now()/1000)>=session.expires_at){close();fail('Encrypted agent session expired; create a fresh session');}
   if(!plainObject(payload))fail('An object payload is required');
   let bytes;try{bytes=encoder.encode(JSON.stringify(payload));}catch{fail('Payload cannot be encoded as JSON');}
   if(bytes.length>MAX_REQUEST_BYTES)fail('Encrypted request exceeds 50KB');
   const request_id=randomUUID();if(seenIds.has(request_id))fail('Repeated local request identifier');seenIds.add(request_id);
   let iv,ivText;for(let i=0;i<5;i++){iv=webcrypto.getRandomValues(new Uint8Array(12));iv[0]=0;ivText=base64(iv);if(!seenIVs.has(ivText))break;iv=null;}
   if(!iv)fail('Cannot obtain a unique request nonce');seenIVs.add(ivText);
   const ciphertext=new Uint8Array(await subtle.encrypt({name:'AES-GCM',iv,additionalData:requestAAD(origin,session.session_id,request_id),tagLength:128},key,bytes));
   const envelope=await post('/api/agent/exchange',{protocol:PROTOCOL,session_id:session.session_id,request_id,iv:ivText,ciphertext:base64(ciphertext)},3000000);
   if(envelope.protocol!==PROTOCOL||envelope.session_id!==session.session_id||envelope.request_id!==request_id||!Number.isInteger(envelope.status)||envelope.status<200||envelope.status>599)fail('Encrypted response metadata does not match the request');
   const responseIV=unbase64(envelope.iv,12,12,'response nonce'),responseIVText=base64(responseIV);
   if(responseIV[0]!==1||!responseIV.subarray(1).every((value,index)=>value===iv[index+1]))fail('Response nonce is not bound to the request direction');
   if(seenIVs.has(responseIVText))fail('Repeated response nonce');seenIVs.add(responseIVText);
   const responseBytes=unbase64(envelope.ciphertext,16,MAX_RESPONSE_BYTES+16,'response ciphertext');
   let decrypted;try{decrypted=new Uint8Array(await subtle.decrypt({name:'AES-GCM',iv:responseIV,additionalData:responseAAD(origin,session.session_id,request_id,envelope.status),tagLength:128},key,responseBytes));}catch{fail('Encrypted response authentication failed');}
   if(decrypted.length>MAX_RESPONSE_BYTES)fail('Decrypted response exceeds the size limit');
   let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decrypted));}catch{fail('Encrypted response plaintext is invalid JSON');}
   if(!plainObject(result)||result.status!==envelope.status||!Object.hasOwn(result,'result'))fail('Authenticated response status is inconsistent');
   return result;
  }
  return{
   protocol:PROTOCOL,network:NETWORK,wallet,sessionId:session.session_id,expiresAt:session.expires_at,
   exchange(payload){const operation=queue.then(()=>perform(payload));queue=operation.catch(()=>{});return operation.catch(error=>{close();if(error instanceof AgentTransportError)throw error;fail('Encrypted agent transport failed without a fallback');});},
   close,
  };
 }catch(error){close();if(error instanceof AgentTransportError)throw error;fail('Cannot establish the encrypted agent session');}
}
