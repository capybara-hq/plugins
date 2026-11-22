-- Runs with search_path "plugin_device_local, public": table names carry no schema prefix.
-- Every row is keyed by the kernel's device id (one connection and one binding per device).

-- What the device's machine said in its last accepted hello, and the owner report every carrier
-- (hello, policy event, binding answer) keeps current. org_id is learned from the kernel's first
-- report call (a hello names no org) and never moves.
CREATE TABLE IF NOT EXISTS connections (
  device_id text PRIMARY KEY,
  org_id text,
  machine_epoch integer NOT NULL DEFAULT 0,
  mode text NOT NULL CHECK (mode IN ('os', 'docker')),
  roots jsonb NOT NULL,
  home text,
  session_isolation boolean NOT NULL,
  features text[] NOT NULL,
  permission_support jsonb NOT NULL,
  owner_report jsonb,
  instance_generation text,
  runtime_identity jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The binding of the device's current instance generation (replaced by every create); the
-- installed facts are what the machine attested in its binding answer.
CREATE TABLE IF NOT EXISTS bindings (
  device_id text PRIMARY KEY,
  instance_id text NOT NULL,
  generation text NOT NULL,
  binding_id text NOT NULL,
  previous_generation text,
  status text NOT NULL CHECK (status IN ('awaiting-device', 'installed')),
  runtime_identity jsonb,
  permission_support jsonb,
  owner_ceiling jsonb,
  unattested boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
