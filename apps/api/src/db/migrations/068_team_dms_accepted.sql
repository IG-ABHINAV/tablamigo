-- 068: DMs from the official team account (users.account_kind = 'team') are never a message request. The welcome DM and the
-- team's replies used to leave the person's side 'pending'; accept every one that is still pending (declined stays declined).
UPDATE chat_members cm SET request_status = 'accepted', request_decided_at = now()
FROM chats c
WHERE c.id = cm.chat_id AND c.kind = 'dm' AND cm.request_status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cm.user_id AND u.account_kind = 'team')
  AND EXISTS (SELECT 1 FROM chat_members t JOIN users tu ON tu.id = t.user_id
              WHERE t.chat_id = c.id AND tu.account_kind = 'team'
                AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.sender_id = tu.id));
