// Rebuild public event ABIs from the pinned Tacit source, without compiling or
// executing upstream code. Deployment addresses remain an explicitly reviewed manifest.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root=process.argv[2]??'../tacit';
const manifest=JSON.parse(fs.readFileSync('indexer/src/vendor/deployments.json','utf8'));
if(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==manifest.revision) throw new Error('Unexpected upstream revision');
const previous=JSON.parse(fs.readFileSync('indexer/src/vendor/evm-events.json','utf8'));
const result={ERC20:previous.ERC20};
const sources={};
function eventType(type,clean,depth=0) {
  if(depth>12) throw new Error('Recursive Solidity event struct');
  if(/^(?:u?int\d*|bytes\d*|address|bool|string)(?:\[\d*\])*$/u.test(type)) return {type};
  const base=type.replace(/\[.*$/,'');const suffix=type.slice(base.length);
  const structs=new Map([...clean.matchAll(/\bstruct\s+(\w+)\s*\{([^}]+)\}/g)].map(([,n,b])=>[n,b]));
  if(!structs.has(base)) throw new Error(`Review complex event type ${type}`);
  const components=structs.get(base).split(';').filter(s=>s.trim()).map(field=>{
    const [t,n]=field.trim().split(/\s+/);return {name:n,...eventType(t,clean,depth+1)};
  });
  return {type:'tuple'+suffix,components};
}

for(const name of new Set([...manifest.contracts.map(c=>c.name),'CanonicalBridgedERC20'])) {
  if(name==='ERC20') continue;
  const relative=`contracts/src/${name==='BitcoinLightRelay'?'lib/':''}${name}.sol`;
  const file=path.join(root,relative);
  if(!fs.existsSync(file)) throw new Error(`Missing ${file}`);
  const source=fs.readFileSync(file,'utf8');
  sources[name]={path:relative,sha256:createHash('sha256').update(source).digest('hex')};
  const clean=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
  result[name]=[...clean.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*;/g)].map(([,event,args])=>({
    type:'event',name:event,anonymous:false,
    inputs:args.split(',').filter(x=>x.trim()).map(arg=>{
      const words=arg.trim().split(/\s+/);const type=words[0];
      return {name:words.at(-1),...eventType(type,clean),indexed:words.includes('indexed')};
    }),
  }));
  // CollateralEngine inherits Solady Ownable; these events are not declared in its own file.
  // https://github.com/Vectorized/solady/blob/main/src/auth/Ownable.sol
  if(name==='CollateralEngine') for(const [event,names] of [['OwnershipTransferred',['oldOwner','newOwner']],['OwnershipHandoverRequested',['pendingOwner']],['OwnershipHandoverCanceled',['pendingOwner']]]) result[name].push({type:'event',name:event,anonymous:false,inputs:names.map(name=>({name,type:'address',indexed:true}))});
  if(name==='WrappedTac') for(const event of result.ERC20) if(!result[name].some(e=>e.name===event.name)) result[name].push(event);
}
for(const event of result.CanonicalBridgedERC20) if(!result.ERC20.some(e=>e.name===event.name)) result.ERC20.push(event);
fs.writeFileSync('indexer/src/vendor/evm-events.json',JSON.stringify(result,null,2)+'\n');
fs.writeFileSync('indexer/src/vendor/evm-provenance.json',JSON.stringify({revision:manifest.revision,sources},null,2)+'\n');
fs.copyFileSync('indexer/src/vendor/deployments.json','frontend/src/data/deployments.json');
const poolSource=fs.readFileSync(path.join(root,'contracts/src/ConfidentialPool.sol'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
const structs=new Map([...poolSource.matchAll(/\bstruct\s+(\w+)\s*\{([^}]+)\}/g)].map(([,name,body])=>[name,body]));
function components(name,depth=0) {
  if(depth>12||!structs.has(name)) throw new Error(`Unsupported Solidity struct ${name}`);
  return structs.get(name).split(';').filter(s=>s.trim()).map(s=>{
    const match=s.trim().match(/^(\w+)(\[\])?\s+(\w+)$/);
    if(!match) throw new Error(`Unsupported ABI field: ${s}`);
    const [,type,array='',field]=match;
    if(structs.has(type)) return {name:field,type:'tuple'+array,components:components(type,depth+1)};
    if(!/^(u?int\d*|bytes\d*|address|bool|string)$/.test(type)) throw new Error(`Unsupported ABI type ${type}`);
    return {name:field,type:(type==='uint'?'uint256':type==='int'?'int256':type)+array};
  });
}
fs.writeFileSync('indexer/src/vendor/public-values.json',JSON.stringify([{name:'values',type:'tuple',components:components('PublicValues')}],null,2)+'\n');
const scan=fs.readFileSync(path.join(root,'dapp/confidential-lock-scan.js'),'utf8');
if(/^import /m.test(scan)) throw new Error('Review new calldata decoder dependencies');
fs.writeFileSync('indexer/src/vendor/confidential-lock-scan.ts','// @ts-nocheck\n// Vendored from Tacit '+manifest.revision+'; MIT, see LICENSE.tacit.\n'+scan);

const amm=fs.readFileSync(path.join(root,'contracts/src/TacitPublicAmm.sol'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
const names=new Set(['createPairAndAddLiquidityPublic','removeLiquidityPublic','removeLiquidityPublicFrom','swapPublic']);
const abi=[...amm.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*((?:external|public)[^{;]*)/g)].filter(([,name])=>names.has(name)).map(([,name,args,tail])=>({
 type:'function',name,stateMutability:tail.includes('payable')?'payable':'nonpayable',
 inputs:args.split(',').filter(x=>x.trim()).map(x=>{const [type,name]=x.trim().split(/\s+/);return {type,name};}),
 outputs:(tail.match(/returns\s*\(([^)]*)\)/)?.[1]??'').split(',').filter(x=>x.trim()).map(x=>{const [type,name='']=x.trim().split(/\s+/);return {type,name};}),
}));
fs.writeFileSync('indexer/src/vendor/public-amm.json',JSON.stringify(abi,null,2)+'\n');
const provenance=JSON.parse(fs.readFileSync('indexer/src/vendor/evm-provenance.json','utf8'));
provenance.sources.calldata={path:'dapp/confidential-lock-scan.js',sha256:createHash('sha256').update(scan).digest('hex')};
fs.writeFileSync('indexer/src/vendor/evm-provenance.json',JSON.stringify(provenance,null,2)+'\n');

const publicPoolAbi=[...poolSource.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*((?:external|public)[^{;]*)/g)].filter(([,name])=>['createPair','createPairAndSettle'].includes(name)).map(([,name,args,tail])=>({
 type:'function',name,stateMutability:'nonpayable',
 inputs:args.split(',').filter(x=>x.trim()).map(x=>{const words=x.trim().split(/\s+/);return {type:words[0],name:words.at(-1)};}),
 outputs:(tail.match(/returns\s*\(([^)]*)\)/)?.[1]??'').split(',').filter(x=>x.trim()).map(x=>{const words=x.trim().split(/\s+/);return {type:words[0],name:words[1]??''};}),
}));
fs.writeFileSync('indexer/src/vendor/public-pool.json',JSON.stringify(publicPoolAbi,null,2)+'\n');
