// supabase/functions/expire-subscription-status/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js';
serve(async (_req)=>{
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const now = new Date().toISOString();
  const expiredTypes = [
    'basic_monthly',
    'basic_yearly'
  ];
  const results = [];
  for (const type of expiredTypes){
    const { error, data } = await supabase.from('user_subscription_status').update({
      subscription_type: 'free',
      updated_at: now
    }).eq('subscription_type', type).lt('subscription_end_date', now);
    results.push({
      type,
      updated: data?.length || 0,
      error: error?.message || null
    });
  }
  const failed = results.filter((r)=>r.error);
  if (failed.length > 0) {
    return new Response(JSON.stringify({
      status: 'error',
      details: failed
    }), {
      status: 500
    });
  }
  return new Response(JSON.stringify({
    status: 'success',
    results
  }), {
    status: 200
  });
});
