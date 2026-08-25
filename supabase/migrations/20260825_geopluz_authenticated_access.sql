-- GEOPLUZ: acceso inicial mediante Supabase Auth y RLS.
-- No crea policies para anon ni permisos DELETE para usuarios autenticados.

REVOKE ALL ON SCHEMA public FROM anon;
REVOKE CREATE ON SCHEMA public FROM authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

REVOKE ALL ON TABLE public.seds, public.llaves, public.fallas FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.seds, public.llaves, public.fallas TO authenticated;

REVOKE ALL ON SEQUENCE public.llaves_id_seq, public.fallas_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.llaves_id_seq, public.fallas_id_seq TO authenticated;

ALTER TABLE public.seds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.llaves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fallas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS geopluz_authenticated_select ON public.seds;
DROP POLICY IF EXISTS geopluz_authenticated_insert ON public.seds;
DROP POLICY IF EXISTS geopluz_authenticated_update ON public.seds;
DROP POLICY IF EXISTS geopluz_authenticated_select ON public.llaves;
DROP POLICY IF EXISTS geopluz_authenticated_insert ON public.llaves;
DROP POLICY IF EXISTS geopluz_authenticated_update ON public.llaves;
DROP POLICY IF EXISTS geopluz_authenticated_select ON public.fallas;
DROP POLICY IF EXISTS geopluz_authenticated_insert ON public.fallas;
DROP POLICY IF EXISTS geopluz_authenticated_update ON public.fallas;

CREATE POLICY geopluz_authenticated_select ON public.seds FOR SELECT TO authenticated USING (true);
CREATE POLICY geopluz_authenticated_insert ON public.seds FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY geopluz_authenticated_update ON public.seds FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY geopluz_authenticated_select ON public.llaves FOR SELECT TO authenticated USING (true);
CREATE POLICY geopluz_authenticated_insert ON public.llaves FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY geopluz_authenticated_update ON public.llaves FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY geopluz_authenticated_select ON public.fallas FOR SELECT TO authenticated USING (true);
CREATE POLICY geopluz_authenticated_insert ON public.fallas FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY geopluz_authenticated_update ON public.fallas FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
