// Read-only gate. Run against staging; exits nonzero until every check passes.
import { evaluateReadiness } from './readiness.js';
evaluateReadiness().then(result=>{console.log(JSON.stringify(result,null,2));process.exit(result.ready?0:1);}).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});
