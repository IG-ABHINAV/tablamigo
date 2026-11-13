-- 028_dm_message_requests.sql: Message request state for first DMs from non-connections
alter table chat_members add column if not exists request_status text not null default 'accepted' check (request_status in ('pending', 'accepted', 'declined'));
create index if not exists idx_chat_members_request_status on chat_members(user_id, request_status);
