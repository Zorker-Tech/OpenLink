-- Reauthorization may use the same durable connection ID across multiple
-- consumed login attempts. Callback consumption and the connection revision
-- fence serialize those attempts; a login-transaction uniqueness constraint
-- must not lock the owner out after denial or an identity mismatch.
alter table openlink_cloud_private.login_transactions
  drop constraint if exists login_transactions_connection_id_key;

notify pgrst, 'reload schema';
