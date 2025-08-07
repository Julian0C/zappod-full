// supabase/functions/transition-trial-to-free/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js';
serve(async (req)=>{
  const { userId } = await req.json();
  if (!userId) {
    return new Response(JSON.stringify({
      error: 'Missing userId'
    }), {
      status: 400
    });
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  // 只更新为 free，如果当前是 trial
  const { error } = await supabase.from('user_subscription_status').update({
    subscription_type: 'free'
  }).eq('user_id', userId).eq('subscription_type', 'trial') // 避免误覆盖其他状态
  ;
  if (error) {
    return new Response(JSON.stringify({
      error: 'Failed to update subscription'
    }), {
      status: 500
    });
  }
  return new Response(JSON.stringify({
    status: 'updated to free'
  }), {
    status: 200
  });
});
