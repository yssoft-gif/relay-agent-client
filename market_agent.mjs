#!/usr/bin/env node
// Node 22+, npm install @stellar/stellar-sdk@17.4.0
// MAINNET. Default inspects payments; only bare --broadcast submits a payment.
// API proofs are signed locally; wallet signing seeds never leave this process.
// Artifact decryption keys are sent only inside the encrypted delivery protocol.
import { readFile, mkdir, open, link, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createAgentTransport, AgentTransportError } from './agent_transport.mjs';
import { Keypair, Networks, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk/base';
const HORIZON='https://horizon.stellar.org';
// Circle's native Stellar MAINNET USDC issuer; same-code tokens are not accepted.
export const STELLAR_USDC_ISSUER='GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
class ClientError extends Error {}
const fail=message=>{throw new ClientError(message);};
const hex=bytes=>Buffer.from(bytes).toString('hex');
const address=value=>typeof value==='string'&&value.startsWith('G')&&StrKey.isValidEd25519PublicKey(value);
export const LOCKED_DELIVERY_PROTOCOL='relay-locked-delivery/1';
const MAX_ARTIFACT_BYTES=1073741824;
const deliveryManifestKeys=['protocol','network','agreement_id','algorithm','iv','sha256','ciphertext_sha256','plaintext_bytes','ciphertext_bytes','key_sha256'];
function artifactBase64(value,length,label){if(typeof value!=='string'||value.length!==4*Math.ceil(length/3))fail(`Invalid ${label}`);const bytes=Buffer.from(value,'base64');if(bytes.length!==length||bytes.toString('base64')!==value)fail(`Invalid ${label}`);return bytes;}
export function normalizeDeliveryManifest(value,agreementId=value?.agreement_id){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==deliveryManifestKeys.length||Object.keys(value).some(k=>!deliveryManifestKeys.includes(k))||value.protocol!==LOCKED_DELIVERY_PROTOCOL||value.network!=='mainnet'||value.algorithm!=='A256GCM'||typeof agreementId!=='string'||!agreementId||agreementId.length>200||/[\u0000-\u001f]/.test(agreementId)||value.agreement_id!==agreementId)fail('Invalid locked delivery manifest');
 artifactBase64(value.iv,12,'artifact IV');for(const k of ['sha256','ciphertext_sha256','key_sha256'])if(typeof value[k]!=='string'||!/^[a-f0-9]{64}$/.test(value[k]))fail('Invalid artifact hash');
 if(!Number.isSafeInteger(value.plaintext_bytes)||value.plaintext_bytes<0||value.plaintext_bytes>MAX_ARTIFACT_BYTES||value.ciphertext_bytes!==value.plaintext_bytes+16)fail('Invalid artifact byte lengths');
 return Object.fromEntries(deliveryManifestKeys.map(key=>[key,value[key]]));
}
export function deliveryAdditionalData(manifest){return Buffer.from(JSON.stringify({domain:LOCKED_DELIVERY_PROTOCOL,network:'mainnet',agreement_id:manifest.agreement_id,sha256:manifest.sha256,plaintext_bytes:manifest.plaintext_bytes}));}
async function fileDigest(path,maximum){const hash=createHash('sha256');let size=0;try{for await(const chunk of createReadStream(path)){size+=chunk.length;if(size>maximum)fail('Artifact exceeds the local size limit');hash.update(chunk);}}catch(error){if(error instanceof ClientError)throw error;fail('Cannot read the local artifact');}return{hash:hash.digest('hex'),size};}
async function atomicFile(outputPath,writer){
 if(typeof outputPath!=='string'||!outputPath)fail('An explicit output file is required');const temp=outputPath+'.relay-tmp-'+randomBytes(12).toString('hex');let file,linked=false;
 try{file=await open(temp,'wx',0o600);await writer(file);await file.sync();await file.close();file=undefined;await link(temp,outputPath);linked=true;}
 catch(error){if(error instanceof ClientError)throw error;fail(error?.code==='EEXIST'?'Output already exists; refusing to overwrite it':'Cannot safely write the local output file');}
 finally{if(file)await file.close().catch(()=>{});await unlink(temp).catch(()=>{});}
 return linked;
}
async function writeAll(file,bytes){let offset=0;while(offset<bytes.length){const result=await file.write(bytes,offset,bytes.length-offset);if(result.bytesWritten<=0)fail('Cannot write the local output file');offset+=result.bytesWritten;}}
/** Small in-memory SDK helper; the file CLI streams large artifacts instead. */
export function encryptLockedArtifact(plaintextBytes,agreementId){
 if(!(plaintextBytes instanceof Uint8Array)||plaintextBytes.byteLength>MAX_ARTIFACT_BYTES||typeof agreementId!=='string'||!agreementId||agreementId.length>200||/[\u0000-\u001f]/.test(agreementId))fail('Valid plaintext bytes and agreement identifier are required');
 const key=randomBytes(32),iv=randomBytes(12);try{const manifest={protocol:LOCKED_DELIVERY_PROTOCOL,network:'mainnet',agreement_id:agreementId,algorithm:'A256GCM',iv:iv.toString('base64'),sha256:createHash('sha256').update(plaintextBytes).digest('hex'),ciphertext_sha256:'0'.repeat(64),plaintext_bytes:plaintextBytes.byteLength,ciphertext_bytes:plaintextBytes.byteLength+16,key_sha256:createHash('sha256').update(key).digest('hex')},cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(deliveryAdditionalData(manifest));const ciphertext=Buffer.concat([cipher.update(plaintextBytes),cipher.final(),cipher.getAuthTag()]);manifest.ciphertext_sha256=createHash('sha256').update(ciphertext).digest('hex');return{ciphertext,delivery_manifest:manifest,decryption_key:key.toString('base64')};}finally{key.fill(0);}
}
/** Offline file protection. No upload, wallet signing, or network call occurs. */
export async function encryptDeliveryFile({inputPath,outputPath,agreementId,keyOutputPath=outputPath+'.key.json'}){
 if(typeof agreementId!=='string'||!agreementId||agreementId.length>200||/[\u0000-\u001f]/.test(agreementId))fail('A valid agreement identifier is required');
 if(inputPath===outputPath||keyOutputPath===outputPath||keyOutputPath===inputPath)fail('Artifact input, encrypted output and private key file must differ');
 const first=await fileDigest(inputPath,MAX_ARTIFACT_BYTES),key=randomBytes(32),iv=randomBytes(12),manifest={protocol:LOCKED_DELIVERY_PROTOCOL,network:'mainnet',agreement_id:agreementId,algorithm:'A256GCM',iv:iv.toString('base64'),sha256:first.hash,ciphertext_sha256:'0'.repeat(64),plaintext_bytes:first.size,ciphertext_bytes:first.size+16,key_sha256:createHash('sha256').update(key).digest('hex')};
 let outputCreated=false,keyCreated=false;
 try{
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(deliveryAdditionalData(manifest));const encryptedHash=createHash('sha256'),plainHash=createHash('sha256');let plainBytes=0,encryptedBytes=0;
  await atomicFile(outputPath,async file=>{for await(const chunk of createReadStream(inputPath)){plainBytes+=chunk.length;if(plainBytes>MAX_ARTIFACT_BYTES)fail('Artifact exceeds the local size limit');plainHash.update(chunk);const bytes=cipher.update(chunk);encryptedHash.update(bytes);encryptedBytes+=bytes.length;await writeAll(file,bytes);}const tail=Buffer.concat([cipher.final(),cipher.getAuthTag()]);encryptedHash.update(tail);encryptedBytes+=tail.length;await writeAll(file,tail);if(plainBytes!==first.size||plainHash.digest('hex')!==first.hash||encryptedBytes!==manifest.ciphertext_bytes)fail('Artifact changed during encryption; retry from an immutable local file');});outputCreated=true;
  manifest.ciphertext_sha256=encryptedHash.digest('hex');normalizeDeliveryManifest(manifest,agreementId);
  await atomicFile(keyOutputPath,file=>writeAll(file,Buffer.from(JSON.stringify({delivery_manifest:manifest,decryption_key:key.toString('base64')},null,2)+'\n')));keyCreated=true;
  return{delivery_manifest:manifest,encrypted_file:outputPath,key_file:keyOutputPath};
 }catch(error){if(outputCreated&&!keyCreated)await unlink(outputPath).catch(()=>{});if(error instanceof ClientError)throw error;fail('Artifact encryption failed safely');}finally{key.fill(0);}
}
/** Authenticated local decryption. A failed check never publishes plaintext. */
export async function decryptDeliveryFile({inputPath,outputPath,manifest:manifestValue,keyBase64}){
 if(inputPath===outputPath)fail('Encrypted input and decrypted output must differ');const manifest=normalizeDeliveryManifest(manifestValue),key=artifactBase64(keyBase64,32,'artifact decryption key');
 try{
  if(createHash('sha256').update(key).digest('hex')!==manifest.key_sha256)fail('Artifact key does not match the manifest');const first=await fileDigest(inputPath,MAX_ARTIFACT_BYTES+16);if(first.size!==manifest.ciphertext_bytes||first.hash!==manifest.ciphertext_sha256)fail('Encrypted artifact hash or size differs from the agreed manifest');
  const decipher=createDecipheriv('aes-256-gcm',key,artifactBase64(manifest.iv,12,'artifact IV'));decipher.setAAD(deliveryAdditionalData(manifest));const plaintextHash=createHash('sha256'),ciphertextHash=createHash('sha256');let plainBytes=0,cipherBytes=0,tail=Buffer.alloc(0);
  await atomicFile(outputPath,async file=>{for await(const chunk of createReadStream(inputPath)){cipherBytes+=chunk.length;if(cipherBytes>manifest.ciphertext_bytes)fail('Encrypted artifact changed during decryption');ciphertextHash.update(chunk);const pending=Buffer.concat([tail,chunk]);if(pending.length<=16){tail=pending;continue;}tail=pending.subarray(pending.length-16);const bytes=decipher.update(pending.subarray(0,pending.length-16));plainBytes+=bytes.length;if(plainBytes>manifest.plaintext_bytes)fail('Decrypted artifact exceeds the agreed size');plaintextHash.update(bytes);await writeAll(file,bytes);}if(tail.length!==16)fail('Encrypted artifact is truncated');decipher.setAuthTag(tail);let final;try{final=decipher.final();}catch{fail('Encrypted artifact authentication failed');}plainBytes+=final.length;plaintextHash.update(final);await writeAll(file,final);if(cipherBytes!==manifest.ciphertext_bytes||ciphertextHash.digest('hex')!==manifest.ciphertext_sha256||plainBytes!==manifest.plaintext_bytes||plaintextHash.digest('hex')!==manifest.sha256)fail('Artifact changed or does not match its agreed plaintext hash');});
  return{output_file:outputPath,sha256:manifest.sha256,plaintext_bytes:plainBytes};
 }catch(error){if(error instanceof ClientError)throw error;fail('Artifact decryption failed safely');}finally{key.fill(0);}
}
export function amount(value){
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,6})(\.\d{1,7})?$/.test(value))fail('Invalid decimal asset amount');
 const[w,f='']=value.split('.');const n=BigInt(w)*10000000n+BigInt(f.padEnd(7,'0'));
 if(n>10000000000000n)fail('Amount exceeds the 1000000 asset-unit safety limit');return n;
}
export function parseFlags(args){
 const flags={},named=new Set(['site','action','file','wallet','agreement','seller','asset','max-amount','max-platform-fee-amount','max-xlm','max-network-fee-xlm','platform-wallet','max-platform-fee-xlm','seller-memo-type','seller-memo','platform-memo-type','platform-memo','journal-dir','encrypt-file','decrypt-file','output','manifest','key-file','key-output']);
 for(let i=0;i<args.length;i++){
  const key=args[i].startsWith('--')?args[i].slice(2):'';if(!key||Object.hasOwn(flags,key))fail('Use unique named flags');
  if(['broadcast','sign-only','trial'].includes(key)){if(args[i+1]&&!args[i+1].startsWith('--'))fail(`--${key} is a bare explicit flag, never a string value`);flags[key]=true;}
  else{if(!named.has(key)||!args[i+1]||args[i+1].startsWith('--'))fail('Unknown flag or missing flag value');flags[key]=args[++i];}
 }
 if(flags.trial&&Object.keys(flags).some(key=>!['trial','site'].includes(key)))fail('--trial accepts only --site; actions, files, wallets and payments are disabled');
 if(flags.broadcast&&(flags.action||flags.file||flags['sign-only']))fail('--broadcast cannot be combined with API action/sign-only');return flags;
}
function sorted(value){if(Array.isArray(value))return value.map(sorted);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])]));return value;}
export function canonicalRequestJson(origin,body,auth){
 const payload={...body};delete payload.auth;
 return JSON.stringify(sorted({domain:'relay-wallet-auth/v1',network:'mainnet',origin:new URL(origin).origin,wallet:auth.wallet,nonce:auth.nonce,issued_at:auth.issued_at,payload}));
}
export function signApiRequest(body,origin,signer,{wallet=signer.publicKey(),nonce=randomBytes(24).toString('hex'),issued_at=Math.floor(Date.now()/1000)}={}){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.hasOwn(body,'auth'))fail('Unsigned logical JSON body without auth is required');
 if(!address(wallet)||wallet!==signer.publicKey())fail('Local signing key does not match the requested actor wallet');
 const roleField=({create_agent_session:'wallet',submit_review:'buyer_wallet',upsert_seller_profile:'wallet',create_post:'wallet',make_offer:'seller_wallet',accept_offer:'buyer_wallet',submit_deliverable:'seller_wallet',approve_delivery:'buyer_wallet',report_issue:'actor_wallet',release_delivery_key:'buyer_wallet',prepare_escrow:'actor_wallet',confirm_escrow:'actor_wallet',reconcile_escrow:'actor_wallet'})[body.action];
 if(roleField&&body[roleField]!==wallet)fail('Local signing key does not match the action actor');
 const auth={wallet,nonce,issued_at};const digest=createHash('sha256').update(canonicalRequestJson(origin,body,auth),'utf8').digest();
 return {...body,auth:{...auth,signature:Buffer.from(signer.sign(digest)).toString('base64')}};
}
function normalizeMemo(type,value){
 type=type??'none';if(!['none','text','id'].includes(type))fail('Unsupported recipient memo type');
 if(type==='none'){if(value!==undefined&&value!==null&&value!=='')fail('Unexpected memo on a no-memo recipient');return{type:'none',value:null};}
 if(typeof value!=='string')fail('Recipient memo value is required');
 if(type==='text'){if(Buffer.byteLength(value,'utf8')>28||Buffer.from(value,'utf8').toString('utf8')!==value)fail('Invalid text memo');}
 else if(!/^(0|[1-9]\d*)$/.test(value)||BigInt(value)>18446744073709551615n)fail('Invalid ID memo');
 return{type,value};
}
function allowedMemo(actual,policyType,policyValue,label){
 if(actual.type!=='none'&&(actual.type!==policyType||actual.value!==policyValue))fail(`${label} memo requires an explicit matching local allowance`);
}
function paymentAsset(code='XLM',issuer=null){
 if(code==='XLM'&&(issuer===null||issuer===undefined))return{code,issuer:null};
 if(code==='USDC'&&issuer===STELLAR_USDC_ISSUER)return{code,issuer};
 fail('Unsupported payment asset or issuer; only XLM and native Circle USDC on Stellar MAINNET are allowed');
}
function quotedAmount(record,generic,legacy,asset){
 const value=record[generic],old=record[legacy];
 if(asset==='USDC'){
  if(old!==undefined&&old!==null)fail('USDC amounts must not be labelled XLM');
  return amount(value);
 }
 const parsed=amount(value??old);
 if(old!==undefined&&old!==null&&amount(old)!==parsed)fail('Generic and legacy XLM amounts differ');
 return parsed;
}
function localAmountAllowance(policy,generic,legacy,asset,defaultValue){
 if(asset==='USDC'&&policy[legacy]!==undefined)fail('USDC requires an explicit asset-unit allowance, not an XLM allowance');
 const value=policy[generic]??policy[legacy]??defaultValue,parsed=amount(value);
 if(asset==='XLM'&&policy[generic]!==undefined&&policy[legacy]!==undefined&&amount(policy[legacy])!==parsed)fail('Conflicting local amount allowances');
 return parsed;
}
/** Independent verification before a MAINNET transaction is signed. */
export function inspectPaymentDraft(contract,draft,policy,{now=Date.now(),allowExpired=false}={}){
 if(contract?.settlement_mode==='soroban_escrow_v1')fail('Escrow agreements require the escrow client; direct payment is refused');
 if(!contract||!draft||!policy||contract.network!=='mainnet'||draft.network!=='mainnet'||!address(contract.buyer_wallet)||!address(contract.seller_wallet)||contract.buyer_wallet===contract.seller_wallet)fail('Invalid MAINNET agreement or wallet');
 const asset=paymentAsset(contract.asset??'XLM',contract.asset_issuer);
 const draftAsset=paymentAsset(draft.asset??'XLM',draft.asset_issuer);
 if(asset.code!==(policy.asset??'XLM')||asset.code!==draftAsset.code||asset.issuer!==draftAsset.issuer||(policy.assetIssuer!==undefined&&policy.assetIssuer!==asset.issuer))fail('Payment asset differs from the explicit local allowance or frozen agreement');
 if(contract.seller_wallet!==policy.seller||!address(policy.seller))fail('Seller does not match the local recipient allowance');
 const total=quotedAmount(contract,'price_amount','price_xlm',asset.code),fee=quotedAmount(contract,'fee_amount','fee_xlm',asset.code),ceiling=localAmountAllowance(policy,'maxAmount','maxXlm',asset.code);
 if(total<=0n||fee>=total||total>ceiling)fail('Payment amount exceeds local authorization');
 if(fee>localAmountAllowance(policy,'maxPlatformFeeAmount','maxPlatformFeeXlm',asset.code,'0'))fail('Platform fee exceeds the local fee allowance');
 if(fee>0n&&(!address(contract.platform_wallet)||contract.platform_wallet!==policy.platformWallet||contract.platform_wallet===contract.buyer_wallet))fail('Platform fee destination requires an explicit local allowance');
 if(String(total)!==String(contract.price_stroops)||String(fee)!==String(contract.fee_stroops||'0'))fail('Agreement decimal and integer amounts differ');
 const sellerMemo=normalizeMemo(contract.seller_memo_type,contract.seller_memo);
 const platformMemo=fee>0n?normalizeMemo(contract.platform_memo_type,contract.platform_memo):{type:'none',value:null};
 allowedMemo(sellerMemo,policy.sellerMemoType,policy.sellerMemo,'Seller');allowedMemo(platformMemo,policy.platformMemoType,policy.platformMemo,'Platform');
 let selected=sellerMemo.type!=='none'?sellerMemo:platformMemo;
 if(sellerMemo.type!=='none'&&platformMemo.type!=='none'&&(sellerMemo.type!==platformMemo.type||sellerMemo.value!==platformMemo.value))fail('Conflicting recipient memos cannot share a Stellar transaction');
 let tx;try{tx=TransactionBuilder.fromXDR(draft.unsigned_xdr,Networks.PUBLIC);}catch{fail('Malformed transaction envelope');}
 if(!(tx instanceof Transaction)||tx.signatures.length)fail('Expected an unsigned classic transaction');
 if(!/^[a-f0-9]{64}$/.test(draft.hash)||hex(tx.hash())!==draft.hash||tx.source!==contract.buyer_wallet||draft.source!==tx.source)fail('Unexpected transaction hash or source');
 const networkFee=BigInt(tx.fee);if(networkFee<=0n||networkFee>amount(policy.maxNetworkFeeXlm||'0.001'))fail('Network fee exceeds the local cap');
 const expires=Number(tx.timeBounds?.maxTime||0)*1000;
 if(tx.timeBounds?.minTime!=='0'||!Number.isSafeInteger(expires)||expires!==Date.parse(draft.expires_at)||expires>now+600000||(!allowExpired&&expires<=now))fail('Unexpected transaction expiry');
 const canonical={protocol:asset.code==='USDC'?'relay-stellar/2':'relay-stellar/1',network:'mainnet',agreement_id:contract.id,buyer_wallet:contract.buyer_wallet,seller_wallet:contract.seller_wallet,price_stroops:String(total),fee_stroops:String(fee),platform_wallet:fee>0n?contract.platform_wallet:null,acceptance:contract.acceptance??'',seller_memo_type:sellerMemo.type,seller_memo:sellerMemo.value,platform_memo_type:platformMemo.type,platform_memo:platformMemo.value};
 if(asset.code==='USDC')Object.assign(canonical,{asset:asset.code,asset_issuer:asset.issuer});
 const contractHash=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
 if(selected.type==='none')selected={type:'hash',value:contractHash};
 const actualMemo=tx.memo.value instanceof Uint8Array?(tx.memo.type==='hash'?hex(tx.memo.value):Buffer.from(tx.memo.value).toString('utf8')):String(tx.memo.value);
 if(tx.memo.type!==selected.type||actualMemo!==selected.value||draft.contract_hash!==contractHash||draft.memo_hash!==contractHash||draft.agreement_id!==contract.id||draft.memo_type!==selected.type||draft.memo_value!==selected.value)fail('Transaction memo or contract hash differs from this agreement');
 const expected=[{destination:contract.seller_wallet,amount:total-fee}];if(fee>0n)expected.push({destination:contract.platform_wallet,amount:fee});
 if(tx.operations.length!==expected.length)fail('Unexpected extra transaction operation');
 tx.operations.forEach((op,i)=>{const e=expected[i];const matchesAsset=op.type==='payment'&&(asset.code==='XLM'?op.asset.isNative():!op.asset.isNative()&&op.asset.getCode()==='USDC'&&op.asset.getIssuer()===STELLAR_USDC_ISSUER);if(op.type!=='payment'||op.source||!matchesAsset||op.destination!==e.destination||amount(op.amount)!==e.amount)fail('Unexpected payment asset, source, recipient or amount');});
 if(draft.seller!==contract.seller_wallet||draft.platform_wallet!==(fee>0n?contract.platform_wallet:null)||quotedAmount(draft,'total_amount','total_xlm',asset.code)!==total||quotedAmount(draft,'amount','amount_xlm',asset.code)!==total-fee||quotedAmount(draft,'fee_amount','fee_xlm',asset.code)!==fee||draft.source_sequence!==tx.sequence||draft.network_fee_max_stroops!==tx.fee)fail('Draft metadata differs from the inspected transaction');
 if(draft.seller_amount!==undefined&&amount(draft.seller_amount)!==total-fee)fail('Draft seller amount differs from the inspected transaction');
 if(asset.code==='USDC'&&draft.seller_amount_xlm!==undefined&&draft.seller_amount_xlm!==null)fail('USDC seller amount must not be labelled XLM');
 if(draft.total_stroops!==undefined&&String(draft.total_stroops)!==String(total)||draft.fee_stroops!==undefined&&String(draft.fee_stroops)!==String(fee))fail('Draft integer amounts differ from the inspected transaction');
 return{tx,asset:asset.code,asset_issuer:asset.issuer,expired:expires<=now};
}

async function readJson(response){
 const reader=response.body?.getReader();if(!reader)fail('Empty JSON response');const chunks=[];let size=0;
 while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>2000000){await reader.cancel();fail('Response is too large');}chunks.push(item.value);}
 let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Remote service did not return JSON');}
 if(!data||typeof data!=='object'||Array.isArray(data))fail('Remote service returned malformed data');return data;
}
async function pinPayment(directory,site,agreement,draft){
 const key=createHash('sha256').update('mainnet\n'+site.origin+'\n'+agreement.id).digest('hex');await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,key+'.json');let file;
 try{file=await open(path,'wx',0o600);await file.writeFile(JSON.stringify({network:'mainnet',site:site.origin,agreement_id:agreement.id,hash:draft.hash}));await file.sync();}
 catch(error){if(error.code!=='EEXIST')fail('Cannot safely persist the payment hash before signing');let saved;try{saved=JSON.parse(await readFile(path,'utf8'));}catch{fail('Existing payment journal is unreadable; do not create another payment');}if(saved.hash!==draft.hash||saved.site!==site.origin||saved.agreement_id!==agreement.id||saved.network!=='mainnet')fail('A different payment hash was already pinned for this agreement; inspect the original transaction');}
 finally{if(file)await file.close();}
}
function checkConfirmed(record,draft,source){
 if(record.hash!==draft.hash||record.successful!==true||record.source_account!==source||!Number.isSafeInteger(record.ledger)||record.ledger<=0)fail('The expected payment is not confirmed');
 let tx;try{tx=TransactionBuilder.fromXDR(record.envelope_xdr,Networks.PUBLIC);}catch{fail('Malformed onchain transaction');}
 if(!(tx instanceof Transaction)||!tx.signatures.length||hex(tx.hash())!==draft.hash)fail('Confirmed transaction envelope differs from the expected payment');
}
async function readArtifactJson(path){let file;try{file=await open(path,'r');const bytes=Buffer.alloc(65537),result=await file.read(bytes,0,bytes.length,0);if(result.bytesRead>65536)fail('Local artifact metadata exceeds 64KB');return JSON.parse(bytes.subarray(0,result.bytesRead).toString('utf8'));}catch(error){if(error instanceof ClientError)throw error;fail('Cannot read the local artifact metadata JSON');}finally{if(file)await file.close().catch(()=>{});}}
function artifactFields(value){if(value?.delivery_access&&typeof value.delivery_access==='object')return value.delivery_access;return value;}
export async function runClient(argv=process.argv.slice(2),environment=process.env){
 const flags=parseFlags(argv);
 if(flags['encrypt-file']||flags['decrypt-file']){
  if(flags['encrypt-file']&&flags['decrypt-file'])fail('Choose either local artifact encryption or decryption');
  const permitted=new Set(['encrypt-file','decrypt-file','output','agreement','manifest','key-file','key-output']);if(Object.keys(flags).some(flag=>!permitted.has(flag)))fail('Local artifact commands cannot be combined with network or signing flags');
  if(!flags.output)fail('An explicit --output path is required');
  if(flags['encrypt-file']){if(!flags.agreement||flags.manifest||flags['key-file'])fail('Encryption requires --agreement and optional --key-output');const result=await encryptDeliveryFile({inputPath:flags['encrypt-file'],outputPath:flags.output,agreementId:flags.agreement,keyOutputPath:flags['key-output']||flags.output+'.key.json'});console.log(JSON.stringify(result,null,2));return;}
  if(!flags.manifest||!flags['key-file']||flags.agreement||flags['key-output'])fail('Decryption requires --manifest and --key-file');
  const metadata=artifactFields(await readArtifactJson(flags.manifest)),keyMetadata=artifactFields(await readArtifactJson(flags['key-file']));const result=await decryptDeliveryFile({inputPath:flags['decrypt-file'],outputPath:flags.output,manifest:metadata?.delivery_manifest??metadata,keyBase64:keyMetadata?.decryption_key});console.log(JSON.stringify(result,null,2));return;
 }
 if(flags.output||flags.manifest||flags['key-file'])fail('Artifact output flags require a local encrypt/decrypt command');
 let site;try{site=new URL(flags.site||'');}catch{fail('Provide a valid --site origin');}
 if(site.protocol!=='https:'&&!(site.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(site.hostname)))fail('Site requires HTTPS, except loopback development');
 if(site.username||site.password||site.search||site.hash||!['','/'].includes(site.pathname))fail('Use a Site origin without embedded credentials');
 // Trial creates only a disposable local signer; no environment keys/tokens, files or payment path.
 if(flags.trial){
  const trialSigner=Keypair.random();let trialTransport;
  try{
   trialTransport=await createAgentTransport({site:site.origin,wallet:trialSigner.publicKey(),signPayload:body=>signApiRequest(body,site.origin,trialSigner)});
   const response=await trialTransport.exchange({action:'snapshot'});
   if(response.status>=400||response.result?.ok===false)fail(`Encrypted trial snapshot rejected the request (HTTP ${response.status})`);
   if(!response.result||typeof response.result!=='object'||Array.isArray(response.result))fail('Encrypted trial returned malformed snapshot data');
   console.log(JSON.stringify({ok:true,mode:'read_only_trial',action:'snapshot',network:'mainnet',encrypted_status:response.status,market_stats:response.result.stats??null,business_records_written:false,funds_sent:false,counts_as_customer_or_trade:false},null,2));
  }catch(error){if(error instanceof ClientError)throw error;if(error instanceof AgentTransportError)fail(`Encrypted trial failed${error.status?' (HTTP '+error.status+')':''}; no plaintext retry was attempted`);fail('Encrypted trial failed safely');}
  finally{trialTransport?.close();}
  return;
 }
 const secrets=[environment.RELAY_SITE_TOKEN,environment.STELLAR_SECRET_KEY].filter(Boolean);
 const output=data=>console.log(JSON.stringify(data,(_key,value)=>typeof value==='string'?secrets.reduce((s,key)=>s.replaceAll(key,'[redacted]'),value):value,2));
 let signer,transport;
 function localSigner(){if(signer)return signer;if(!environment.STELLAR_SECRET_KEY)fail('Inject STELLAR_SECRET_KEY securely into this local process; never send it to the Site');try{signer=Keypair.fromSecret(environment.STELLAR_SECRET_KEY);}catch{fail('Invalid local signing key; its value is never logged');}return signer;}
 async function api(body,wallet){
  const actor=wallet||localSigner().publicKey();
  const payload=body?signApiRequest(body,site.origin,localSigner(),{wallet:actor}):{action:'snapshot'};
  try{
   if(!transport)transport=await createAgentTransport({site:site.origin,wallet:localSigner().publicKey(),serviceToken:environment.RELAY_SITE_TOKEN||'',signPayload:sessionBody=>signApiRequest(sessionBody,site.origin,localSigner())});
   const response=await transport.exchange(payload);
   if(response.status>=400||response.result?.ok===false)fail(`Encrypted agent API rejected the request (HTTP ${response.status})`);
   if(!response.result||typeof response.result!=='object')fail('Encrypted agent API returned malformed business data');
   return response.result;
  }catch(error){if(error instanceof ClientError)throw error;if(error instanceof AgentTransportError)fail(`Encrypted agent API failed${error.status?' (HTTP '+error.status+')':''}; no plaintext retry was attempted`);fail('Encrypted agent request failed safely');}
 }
 if(flags.action||flags.file||flags['sign-only']){
  let input={};if(flags.file){let raw;try{raw=await readFile(flags.file,'utf8');}catch{fail('Cannot read the local JSON request');}if(Buffer.byteLength(raw)>50000)fail('Local JSON request exceeds 50KB');try{input=JSON.parse(raw);}catch{fail('Local request must contain valid JSON');}}
  if(!input||typeof input!=='object'||Array.isArray(input))fail('JSON object required');
  let body=input,wallet=flags.wallet;
  if(Object.hasOwn(input,'payload')){if(input.origin!==site.origin||input.network!=='mainnet'||!address(input.wallet)||!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload))fail('Signing request origin, network or actor differs');body=input.payload;wallet=input.wallet;}
  if(flags.action&&body.action&&body.action!==flags.action)fail('Action flag differs from the signing request');
  body={...body,action:flags.action||body.action};if(typeof body.action!=='string'||!body.action)fail('Logical action is required');
  if(typeof body.decryption_key==='string')secrets.push(body.decryption_key);
  if(flags['sign-only']){if(JSON.stringify(body).includes('"decryption_key"'))fail('Artifact keys may only be sent through the encrypted transport; --sign-only would expose the key');if(flags['key-output'])fail('--key-output is used only for encrypted key release');output(signApiRequest(body,site.origin,localSigner(),{wallet:wallet||localSigner().publicKey()}));return;}
  if(body.action==='release_delivery_key'){
   if(!flags['key-output'])fail('Key release requires --key-output to save the key privately');
   const response=await api(body,wallet),access=artifactFields(response),manifest=normalizeDeliveryManifest(access?.delivery_manifest,body.agreement_id),releasedKey=artifactBase64(access?.decryption_key,32,'released artifact key');
   try{if(createHash('sha256').update(releasedKey).digest('hex')!==manifest.key_sha256)fail('Released artifact key does not match the agreed manifest');}finally{releasedKey.fill(0);}
   await atomicFile(flags['key-output'],file=>writeAll(file,Buffer.from(JSON.stringify(access,null,2)+'\n')));output({ok:true,agreement_id:body.agreement_id,payment_hash:access.payment_hash,key_file:flags['key-output']});return;
  }
  if(flags['key-output'])fail('--key-output is used only for encrypted key release');
  output(body.action==='snapshot'?await api():await api(body,wallet));return;
 }
 if(flags['key-output'])fail('--key-output requires an encrypted key release action');
 if(!flags.agreement||!flags.seller||(!flags['max-xlm']&&!flags['max-amount']))fail('Use --agreement, --seller and --max-amount (legacy XLM: --max-xlm); USDC also requires --asset USDC. Submission additionally requires bare --broadcast');
 if(flags.asset!==undefined&&!['XLM','USDC'].includes(flags.asset))fail('--asset must be XLM or USDC on Stellar MAINNET');
 if(flags.asset==='USDC'&&(flags['max-xlm']!==undefined||flags['max-platform-fee-xlm']!==undefined))fail('USDC requires --max-amount and --max-platform-fee-amount; XLM caps apply only to network fees');
 const before=await api();if(!Array.isArray(before.agreements))fail('Site did not return agreements');const contract=before.agreements.find(a=>a.id===flags.agreement);if(!contract)fail('Agreement not found');
 if(!['approved','paid'].includes(contract.status))fail('Buyer has not approved this delivery');
 const response=await api({action:'prepare_payment',agreement_id:contract.id},contract.buyer_wallet);const draft=response.draft;
 const inspected=inspectPaymentDraft(contract,draft,{asset:flags.asset??'XLM',seller:flags.seller,maxAmount:flags['max-amount'],maxXlm:flags['max-xlm'],maxPlatformFeeAmount:flags['max-platform-fee-amount'],platformWallet:flags['platform-wallet'],maxPlatformFeeXlm:flags['max-platform-fee-xlm'],maxNetworkFeeXlm:flags['max-network-fee-xlm'],sellerMemoType:flags['seller-memo-type'],sellerMemo:flags['seller-memo'],platformMemoType:flags['platform-memo-type'],platformMemo:flags['platform-memo']},{allowExpired:true});
 const{tx}=inspected;
 output({network:'mainnet',asset:inspected.asset,asset_issuer:inspected.asset_issuer,source:tx.source,seller:contract.seller_wallet,total_amount:contract.price_amount??contract.price_xlm,fee_amount:contract.fee_amount??contract.fee_xlm,total_xlm:contract.price_xlm,fee_xlm:contract.fee_xlm,memo_type:draft.memo_type,memo_value:draft.memo_value,network_fee_max_stroops:tx.fee,hash:draft.hash,mode:flags.broadcast===true?'explicit_broadcast':'inspection_only'});
 if(flags.broadcast!==true)return;
 let prior;try{const r=await fetch(HORIZON+'/transactions/'+draft.hash,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});if(r.status!==404){prior=await readJson(r);if(!r.ok)fail('Cannot establish existing payment status');}}catch{fail(`Payment status is uncertain. Check the SAME hash ${draft.hash}; do not create another payment.`);}
 if(prior){checkConfirmed(prior,draft,tx.source);try{output(await api({action:'confirm_payment',agreement_id:contract.id,tx_hash:draft.hash},contract.buyer_wallet));}catch{fail(`Payment is confirmed on MAINNET. Retry Site confirmation with the SAME hash ${draft.hash}; do not pay again.`);}return;}
 if(inspected.expired)fail(`Payment draft expired. Check only the SAME hash ${draft.hash}; automatic replacement is disabled.`);
 if(localSigner().publicKey()!==tx.source)fail('Local signer does not match the buyer wallet');
 await pinPayment(flags['journal-dir']||join(homedir(),'.relay-agent','mainnet-payments'),site,contract,draft);
 tx.sign(localSigner());
 try{const r=await fetch(HORIZON+'/transactions',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({tx:tx.toXDR()}),redirect:'error',signal:AbortSignal.timeout(30000)});const submitted=await readJson(r);if(!r.ok||submitted.hash!==draft.hash||submitted.successful===false)fail('Unconfirmed submission');}
 catch{fail(`Payment status is uncertain. Check the SAME hash ${draft.hash}; do not create another payment.`);}
 try{output(await api({action:'confirm_payment',agreement_id:contract.id,tx_hash:draft.hash},contract.buyer_wallet));}catch{fail(`Payment is confirmed on MAINNET. Retry Site confirmation with the SAME hash ${draft.hash}; do not pay again.`);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){runClient().catch(error=>{console.error(error instanceof ClientError?error.message:'Operation failed safely; no private key or token is logged.');process.exitCode=1;});}
