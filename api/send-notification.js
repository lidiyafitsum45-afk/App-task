const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

webpush.setVapidDetails(
  'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // Verify this came from our own Supabase webhook, not a random POST.
  if (req.headers['x-webhook-secret'] !== process.env.SUPABASE_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const row = req.body.record;
  if (!row || !row.recipient_id) return res.status(200).json({ skipped: true });

  const { data: profile } = await admin
    .from('profiles')
    .select('push_subscription')
    .eq('id', row.recipient_id)
    .maybeSingle();

  if (!profile || !profile.push_subscription) return res.status(200).json({ skipped: 'no subscription' });

  try {
    await webpush.sendNotification(
      profile.push_subscription,
      JSON.stringify({ title: row.title, body: row.body, taskId: row.task_id })
    );
  } catch (err) {
    // 410/404 means the subscription expired — clear it so we stop retrying.
    if (err.statusCode === 410 || err.statusCode === 404) {
      await admin.from('profiles').update({ push_subscription: null }).eq('id', row.recipient_id);
    }
    return res.status(200).json({ sent: false, error: err.message });
  }

  res.status(200).json({ sent: true });
};
