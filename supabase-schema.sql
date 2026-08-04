-- ============================================================
-- Priority — v1 schema
-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query)
-- ============================================================

create extension if not exists pgcrypto;

-- One row per team member, linked to Supabase Auth
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  push_subscription jsonb,
  created_at timestamptz not null default now()
);

-- Tasks. Chain fields are nullable — a normal task just has chain_id = null.
create table tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  assignee_id uuid references profiles(id),
  created_by uuid references profiles(id) not null,
  due_date timestamptz,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  important boolean not null default false,
  chain_id uuid,                -- groups tasks that belong to the same chain
  chain_order int,              -- position within the chain, 0-based
  chain_status text check (chain_status in ('active', 'queued', 'done')),
  notified_assignment boolean not null default false,
  notified_due boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Queue of notifications to send. A Supabase Database Webhook (configured in
-- the dashboard, see README) fires on INSERT here and calls the Vercel function.
create table notifications_queue (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid references profiles(id) not null,
  title text not null,
  body text not null,
  task_id uuid references tasks(id),
  created_at timestamptz not null default now()
);

create index tasks_assignee_idx on tasks(assignee_id);
create index tasks_chain_idx on tasks(chain_id, chain_order);
create index notifications_queue_created_idx on notifications_queue(created_at);

-- ---------- Row Level Security ----------
-- Internal team tool: any signed-in team member can read/write everything.
alter table profiles enable row level security;
alter table tasks enable row level security;
alter table notifications_queue enable row level security;

create policy "profiles readable by team" on profiles for select using (auth.role() = 'authenticated');
create policy "profiles editable by owner" on profiles for update using (auth.uid() = id);
create policy "profiles insertable by owner" on profiles for insert with check (auth.uid() = id);

create policy "tasks readable by team" on tasks for select using (auth.role() = 'authenticated');
create policy "tasks insertable by team" on tasks for insert with check (auth.role() = 'authenticated');
create policy "tasks editable by team" on tasks for update using (auth.role() = 'authenticated');
create policy "tasks deletable by team" on tasks for delete using (auth.role() = 'authenticated');

create policy "queue insertable by team" on notifications_queue for insert with check (auth.role() = 'authenticated');
create policy "queue readable by service role only" on notifications_queue for select using (false);

-- ---------- updated_at auto-touch ----------
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tasks_touch_updated_at before update on tasks
  for each row execute function touch_updated_at();

-- ---------- Notify on assignment ----------
create or replace function notify_on_assignment() returns trigger as $$
begin
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and new.notified_assignment = false then
    insert into notifications_queue (recipient_id, title, body, task_id)
    values (new.assignee_id, 'New task assigned', new.title, new.id);
    new.notified_assignment = true;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger tasks_notify_assignment
  before insert or update on tasks
  for each row execute function notify_on_assignment();

-- ---------- Chain activation: completing a task activates the next in line ----------
create or replace function advance_chain() returns trigger as $$
declare
  next_task tasks%rowtype;
begin
  if new.status = 'done' and old.status is distinct from 'done' and new.chain_id is not null then
    update tasks set chain_status = 'done' where id = new.id;

    select * into next_task from tasks
      where chain_id = new.chain_id
        and chain_order > new.chain_order
        and chain_status = 'queued'
      order by chain_order asc
      limit 1;

    if found then
      update tasks set chain_status = 'active' where id = next_task.id;
      if next_task.assignee_id is not null then
        insert into notifications_queue (recipient_id, title, body, task_id)
        values (next_task.assignee_id, 'Next task in chain is ready', next_task.title, next_task.id);
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger tasks_advance_chain
  after update on tasks
  for each row execute function advance_chain();

-- ---------- Realtime ----------
alter publication supabase_realtime add table tasks;
