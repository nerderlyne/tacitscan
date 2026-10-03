import type { APIRoute } from 'astro';
import { protocolActivity,protocolStatus,protocolReadiness } from '../../lib/protocol-queries';
export const GET:APIRoute=async({url})=>{
  const view=url.searchParams.get('view');
  const result=view==='readiness'?await protocolReadiness():view==='status'?await protocolStatus():await protocolActivity(url.searchParams.get('view')??'activity',url.searchParams.get('chain')??'',url.searchParams.get('q')??'');
  return new Response(JSON.stringify(result),{status:result.error||(view==='readiness'&&'ready' in result.data&&!result.data.ready)?503:200,headers:{'content-type':'application/json','cache-control':'no-store'}});
};
