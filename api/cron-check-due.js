const { createClient } = require('@supabase/supabase-js');

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  // Vercel Cron calls this on schedule; also gate with a secret so it can't be spammed publicly.
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  const now = new Date();
  const soonCutoff = new Date(now.getTime() + 60 * 60 * 1000).toISOString(); // due within 1 hour

  const { data: dueSoon } = await admin
    .from('tasks')
    .select('id, title, assignee_id, due_date')
    .neq('status', 'done')
    .eq('notified_due', false)
    .not('due_date', 'is', null)
    .lte('due_date', soonCutoff);

  if (dueSoon && dueSoon.length) {
    const queueRows = dueSoon
      .filter(t => t.assignee_id)
      .map(t => ({
        recipient_id: t.assignee_id,
        title: new Date(t.due_date) < now ? 'Task overdue' : 'Task due soon',
        body: t.title,
        task_id: t.id,
      }));
    if (queueRows.length) await admin.from('notifications_queue').insert(queueRows);
    await admin.from('tasks').update({ notified_due: true }).in('id', dueSoon.map(t => t.id));
  }

  res.status(200).json({ processed: dueSoon ? dueSoon.length : 0 });
};
