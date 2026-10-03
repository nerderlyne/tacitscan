import type { APIRoute } from 'astro';
import { ethereumAllocation } from '../../lib/ethereum-airdrop';
export const GET:APIRoute=async({url})=>{
  try {return Response.json(await ethereumAllocation(url.searchParams.get('address')??''),{headers:{'cache-control':'no-store'}});}
  catch(e) {return Response.json({error:e instanceof Error?e.message:'Unavailable'},{status:400,headers:{'cache-control':'no-store'}});}
};
