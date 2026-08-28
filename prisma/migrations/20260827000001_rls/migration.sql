-- Row-Level Security: a segunda barreira de isolamento entre tenants.
--
-- A primeira barreira é a Prisma Client Extension, que injeta tenantId em
-- todo where/create. Ela cobre o caso normal. Esta migration cobre o caso
-- em que a primeira falha: um `$queryRaw` escrito à mão, um bug na extension,
-- uma consulta nova que esqueceu o filtro.
--
-- O contrato: a aplicação conecta como `agente_app`, que NÃO é dona das
-- tabelas e NÃO tem BYPASSRLS. Toda transação precisa fazer
-- `SET LOCAL app.tenant_id = '<id>'` antes de tocar em dado de negócio.
-- Sem isso, current_setting devolve string vazia e nenhuma linha casa.
--
-- Migrations e administração usam o dono das tabelas, que ignora RLS.

-- ------------------------------------------------------------
-- Role da aplicação
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agente_app') THEN
    CREATE ROLE agente_app LOGIN PASSWORD 'agente_app_dev';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO agente_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agente_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agente_app;

-- Tabelas criadas por migrations futuras já nascem acessíveis.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agente_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agente_app;

-- ------------------------------------------------------------
-- Helper: o tenant da transação corrente
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

-- ------------------------------------------------------------
-- Policies
--
-- Aplicadas a toda tabela que carrega tenant_id. As tabelas sem tenant
-- (usuario) e as de junção (servico_profissional, que herda o isolamento
-- pelas FKs) ficam de fora.
-- ------------------------------------------------------------
DO $$
DECLARE
  t text;
  tabelas text[] := ARRAY[
    'tenant', 'membership', 'config_negocio', 'constituicao', 'persona',
    'marca', 'servico', 'profissional', 'etapa_funil', 'ferramenta_ativa',
    'contato', 'conversa', 'mensagem', 'agendamento', 'trace_agente'
  ];
  coluna text;
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    -- A tabela `tenant` se identifica pelo próprio id.
    coluna := CASE WHEN t = 'tenant' THEN 'id' ELSE 'tenant_id' END;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE faz a policy valer inclusive para o dono da tabela, evitando
    -- que rodar como superusuário mascare um vazamento em teste.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolamento ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolamento ON %I
        USING (%I = app_tenant_id())
        WITH CHECK (%I = app_tenant_id())
    $f$, t, coluna, coluna);
  END LOOP;
END
$$;

-- ------------------------------------------------------------
-- Role de super-admin: ignora RLS por desenho.
-- Usada só pelas rotas de administração da plataforma.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agente_admin') THEN
    CREATE ROLE agente_admin LOGIN PASSWORD 'agente_admin_dev' BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO agente_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agente_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agente_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agente_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agente_admin;
