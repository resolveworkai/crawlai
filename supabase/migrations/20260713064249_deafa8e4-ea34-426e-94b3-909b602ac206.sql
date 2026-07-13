
-- =========================================
-- Enums
-- =========================================
CREATE TYPE public.app_role AS ENUM ('admin', 'operator', 'viewer');
CREATE TYPE public.job_status AS ENUM ('pending','discovering','crawling','completed','failed','cancelled');
CREATE TYPE public.log_level AS ENUM ('info','warn','error','debug');

-- =========================================
-- Shared timestamp trigger
-- =========================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- =========================================
-- profiles
-- =========================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================
-- user_roles
-- =========================================
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

-- Signup trigger: creates profile + default operator role
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'));
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'operator');
  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =========================================
-- crawl_jobs
-- =========================================
CREATE TABLE public.crawl_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_type TEXT NOT NULL,
  location_label TEXT,
  center_lat DOUBLE PRECISION NOT NULL,
  center_lng DOUBLE PRECISION NOT NULL,
  radius_km NUMERIC(6,2) NOT NULL,
  status public.job_status NOT NULL DEFAULT 'pending',
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  found_count INT NOT NULL DEFAULT 0,
  crawled_count INT NOT NULL DEFAULT 0,
  website_crawled_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  current_business TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crawl_jobs TO authenticated;
GRANT ALL ON public.crawl_jobs TO service_role;
ALTER TABLE public.crawl_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner or admin read jobs" ON public.crawl_jobs FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Owner insert jobs" ON public.crawl_jobs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owner or admin update jobs" ON public.crawl_jobs FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Owner or admin delete jobs" ON public.crawl_jobs FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_crawl_jobs_updated BEFORE UPDATE ON public.crawl_jobs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_crawl_jobs_user_created ON public.crawl_jobs(user_id, created_at DESC);

-- =========================================
-- crawl_logs
-- =========================================
CREATE TABLE public.crawl_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES public.crawl_jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  level public.log_level NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.crawl_logs TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crawl_logs_id_seq TO authenticated;
GRANT ALL ON public.crawl_logs TO service_role;
ALTER TABLE public.crawl_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner or admin read logs" ON public.crawl_logs FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Owner insert logs" ON public.crawl_logs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_crawl_logs_job_ts ON public.crawl_logs(job_id, ts DESC);

-- =========================================
-- businesses (master DB)
-- =========================================
CREATE TABLE public.businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id UUID REFERENCES public.crawl_jobs(id) ON DELETE SET NULL,

  -- identity
  name TEXT NOT NULL,
  sub_name TEXT,
  category TEXT,
  tags TEXT[],
  description TEXT,

  -- map
  google_map_name TEXT,
  google_map_url TEXT,
  osm_id TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,

  -- web
  website_url TEXT,
  website_title TEXT,
  meta_description TEXT,
  meta_keywords TEXT,
  about_text TEXT,
  contact_url TEXT,

  -- contact
  email TEXT,
  emails TEXT[],
  phone TEXT,
  phones TEXT[],
  whatsapp TEXT,

  -- socials
  facebook TEXT,
  instagram TEXT,
  linkedin TEXT,
  youtube TEXT,
  twitter TEXT,

  -- address
  address_line1 TEXT,
  address_line2 TEXT,
  area TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  postal_code TEXT,

  -- gbp
  google_rating NUMERIC(3,2),
  review_count INT,
  review_url TEXT,
  business_status TEXT,
  opening_date DATE,
  claimed BOOLEAN,
  price_level TEXT,

  -- hours (jsonb keyed by weekday)
  opening_hours JSONB,

  -- images
  logo_url TEXT,
  cover_image_url TEXT,
  hero_image_url TEXT,

  -- ai
  ai_summary TEXT,
  services TEXT[],
  products TEXT[],
  amenities TEXT[],
  keywords TEXT[],
  languages TEXT[],
  target_audience TEXT,
  industry TEXT,

  -- people
  owner_name TEXT,
  manager_name TEXT,
  reception_number TEXT,
  support_email TEXT,
  sales_email TEXT,
  general_email TEXT,

  -- technical
  ssl_enabled BOOLEAN,
  cms TEXT,
  hosting_provider TEXT,
  google_analytics BOOLEAN,
  facebook_pixel BOOLEAN,

  -- user-defined dynamic fields
  extras JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO authenticated;
GRANT ALL ON public.businesses TO service_role;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner or admin read businesses" ON public.businesses FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Owner insert businesses" ON public.businesses FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owner or admin update businesses" ON public.businesses FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Owner or admin delete businesses" ON public.businesses FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_businesses_updated BEFORE UPDATE ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX ux_businesses_user_email ON public.businesses(user_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX idx_businesses_user_name_phone ON public.businesses(user_id, lower(name), phone);
CREATE INDEX idx_businesses_user_city ON public.businesses(user_id, city);
CREATE INDEX idx_businesses_job ON public.businesses(job_id);

-- =========================================
-- business_images
-- =========================================
CREATE TABLE public.business_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.business_images TO authenticated;
GRANT ALL ON public.business_images TO service_role;
ALTER TABLE public.business_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner or admin read images" ON public.business_images FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Owner insert images" ON public.business_images FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owner or admin delete images" ON public.business_images FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'));
CREATE INDEX idx_business_images_business ON public.business_images(business_id);

-- =========================================
-- dynamic_fields
-- =========================================
CREATE TABLE public.dynamic_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dynamic_fields TO authenticated;
GRANT ALL ON public.dynamic_fields TO service_role;
ALTER TABLE public.dynamic_fields ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner read fields" ON public.dynamic_fields FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owner write fields" ON public.dynamic_fields FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_dynamic_fields_updated BEFORE UPDATE ON public.dynamic_fields FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================
-- crawl_settings (per-user)
-- =========================================
CREATE TABLE public.crawl_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  concurrency INT NOT NULL DEFAULT 3,
  retry_count INT NOT NULL DEFAULT 2,
  timeout_ms INT NOT NULL DEFAULT 15000,
  user_agent TEXT NOT NULL DEFAULT 'LovableBusinessCrawler/1.0',
  map_provider TEXT NOT NULL DEFAULT 'osm',
  discovery_source TEXT NOT NULL DEFAULT 'osm',
  max_businesses_per_job INT NOT NULL DEFAULT 200,
  crawl_website BOOLEAN NOT NULL DEFAULT true,
  use_ai_extraction BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crawl_settings TO authenticated;
GRANT ALL ON public.crawl_settings TO service_role;
ALTER TABLE public.crawl_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner manage settings" ON public.crawl_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_crawl_settings_updated BEFORE UPDATE ON public.crawl_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
