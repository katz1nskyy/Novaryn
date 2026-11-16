-- Run in the SQL Editor of a dedicated Supabase Free project.
begin;

create schema if not exists slowtrace_cloud;
revoke all on schema slowtrace_cloud from public, anon, authenticated, service_role;

create table if not exists slowtrace_cloud.owners (
    user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists slowtrace_cloud.runs (
    id uuid primary key default gen_random_uuid(),
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    status text not null default 'running'
        check (status in ('running', 'completed', 'paused', 'interrupted', 'error')),
    reason text,
    usage jsonb not null default '{}'
);

create table if not exists slowtrace_cloud.worker (
    singleton boolean primary key default true check (singleton),
    run_id uuid references slowtrace_cloud.runs(id),
    expires_at timestamptz,
    checkpoint jsonb not null default '{}',
    checkpoint_at timestamptz,
    last_successful_run timestamptz,
    storage_paused boolean not null default false
);
insert into slowtrace_cloud.worker default values on conflict do nothing;

create table if not exists slowtrace_cloud.receipts (
    run_id uuid not null references slowtrace_cloud.runs(id),
    id uuid not null,
    primary key (run_id, id)
);

-- Version-specific products preserve evidence URLs. Count unique native
-- observations separately so reprocessed releases do not inflate progress.
create table if not exists slowtrace_cloud.observations (
    id text primary key,
    preprocessed boolean not null
);

create table if not exists slowtrace_cloud.products (
    id text primary key check (length(id) between 1 and 240),
    observation_id text not null check (length(observation_id) between 1 and 240),
    release text not null check (release in ('dr1', 'qr3')),
    version text not null check (length(version) between 1 and 160),
    metadata jsonb not null check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
    state text not null check (state in ('discovered', 'preprocessed', 'retry', 'blocked')),
    attempts integer not null default 0 check (attempts >= 0),
    retry_at timestamptz,
    created_at timestamptz not null default now(),
    processed_at timestamptz,
    run_id uuid not null references slowtrace_cloud.runs(id),
    detector integer generated always as ((metadata->>'detector')::integer) stored,
    center_dec double precision generated always as
        (coalesce(metadata->>'center_dec', metadata#>>'{center,dec}')::double precision) stored,
    center_ra double precision generated always as
        (coalesce(metadata->>'center_ra', metadata#>>'{center,ra}')::double precision) stored,
    check (detector between 1 and 6),
    check (center_dec between -90 and 90),
    check (center_ra >= 0 and center_ra < 360)
);
create index if not exists slowtrace_products_pending
    on slowtrace_cloud.products (retry_at, attempts, created_at, id)
    where state in ('retry', 'discovered');
create index if not exists slowtrace_products_neighbors
    on slowtrace_cloud.products (detector, center_dec)
    where state = 'preprocessed';

create table if not exists slowtrace_cloud.groups (
    id text primary key check (length(id) between 1 and 240),
    algorithm text not null check (length(algorithm) between 1 and 160),
    product_ids text[] not null check (cardinality(product_ids) between 2 and 50),
    -- DeepTrace retains the original observation metadata and hashed input signatures.
    metadata jsonb not null check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 65536),
    state text not null check (state in ('compatible', 'searched', 'retry', 'blocked')),
    attempts integer not null default 0 check (attempts >= 0),
    retry_at timestamptz,
    created_at timestamptz not null default now(),
    searched_at timestamptz,
    run_id uuid not null references slowtrace_cloud.runs(id)
);
create index if not exists slowtrace_groups_pending
    on slowtrace_cloud.groups (retry_at, attempts, created_at, id)
    where state in ('retry', 'compatible');

create table if not exists slowtrace_cloud.candidates (
    id text primary key check (length(id) between 1 and 240),
    group_id text not null references slowtrace_cloud.groups(id),
    ra double precision not null check (ra >= 0 and ra < 360),
    dec double precision not null check (dec between -90 and 90),
    classification text not null check (classification in ('unresolved', 'known_match', 'artifact', 'insufficient')),
    evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 32768),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists slowtrace_candidates_group on slowtrace_cloud.candidates (group_id, created_at desc, id);
create index if not exists slowtrace_candidates_recent on slowtrace_cloud.candidates (created_at desc, id);

create table if not exists slowtrace_cloud.jobs (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    ra numeric(9, 6) not null check (ra >= 0 and ra < 360),
    dec numeric(8, 6) not null check (dec between -90 and 90),
    fov numeric(5, 2) not null check (fov between 2 and 30),
    detector integer not null check (detector between 0 and 6),
    state text not null default 'queued'
        check (state in ('queued', 'running', 'searched', 'insufficient', 'retry', 'blocked')),
    attempts integer not null default 0,
    run_id uuid references slowtrace_cloud.runs(id),
    group_id text references slowtrace_cloud.groups(id),
    message text,
    retry_at timestamptz,
    requested_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists slowtrace_jobs_owner on slowtrace_cloud.jobs (owner_id, requested_at desc);
create index if not exists slowtrace_jobs_queue on slowtrace_cloud.jobs (requested_at) where state in ('queued', 'retry');

create table if not exists slowtrace_cloud.metrics (
    singleton boolean primary key default true check (singleton),
    discovered bigint not null default 0,
    preprocessed bigint not null default 0,
    compatible_groups bigint not null default 0,
    searched_groups bigint not null default 0,
    moving_candidates bigint not null default 0,
    known_matches bigint not null default 0,
    rejected_artifacts bigint not null default 0,
    unresolved_candidates bigint not null default 0
);
insert into slowtrace_cloud.metrics default values on conflict do nothing;

alter table slowtrace_cloud.owners enable row level security;
alter table slowtrace_cloud.runs enable row level security;
alter table slowtrace_cloud.worker enable row level security;
alter table slowtrace_cloud.receipts enable row level security;
alter table slowtrace_cloud.observations enable row level security;
alter table slowtrace_cloud.products enable row level security;
alter table slowtrace_cloud.groups enable row level security;
alter table slowtrace_cloud.candidates enable row level security;
alter table slowtrace_cloud.jobs enable row level security;
alter table slowtrace_cloud.metrics enable row level security;
revoke all on all tables in schema slowtrace_cloud from public, anon, authenticated, service_role;

create or replace function slowtrace_cloud.storage_full()
returns boolean language sql volatile set search_path = '' as $$
    -- Leave room for a bounded batch and index growth before the 250 MB target.
    select pg_database_size(current_database()) >= 245000000;
$$;

create or replace function slowtrace_cloud.require_lease(p_lease_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
    perform 1 from slowtrace_cloud.worker
        where singleton and run_id = p_lease_id and expires_at > clock_timestamp()
        for update;
    if not found then
        raise exception 'Worker lease is absent or expired';
    end if;
end;
$$;

create or replace function public.slowtrace_worker_acquire(p_lease_seconds integer, p_claim_jobs boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    worker_row slowtrace_cloud.worker%rowtype;
    lease uuid;
    job_row slowtrace_cloud.jobs%rowtype;
begin
    if p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
        raise exception 'Lease duration must be 60–900 seconds';
    end if;
    select * into worker_row from slowtrace_cloud.worker where singleton for update;
    if worker_row.expires_at > clock_timestamp() then
        return jsonb_build_object('reason', 'lease_held');
    end if;
    if worker_row.expires_at is not null then
        update slowtrace_cloud.runs set status = 'interrupted', finished_at = clock_timestamp(),
            reason = 'Lease expired before the worker finished.' where id = worker_row.run_id;
        update slowtrace_cloud.jobs
            set state = case when attempts >= 3 then 'blocked' else 'retry' end,
                message = 'The worker stopped before committing a result.',
                retry_at = null, updated_at = clock_timestamp()
            where run_id = worker_row.run_id and state = 'running';
        update slowtrace_cloud.worker set expires_at = null where singleton;
    end if;
    if slowtrace_cloud.storage_full() then
        update slowtrace_cloud.worker set storage_paused = true where singleton;
        return jsonb_build_object('reason', 'storage_limit');
    end if;

    insert into slowtrace_cloud.runs default values returning id into lease;
    update slowtrace_cloud.worker set run_id = lease, storage_paused = false,
        expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds) where singleton;
    -- Only the current lease can submit a transaction. Once the next lease has
    -- begun, its checkpoint supersedes old delivery receipts.
    delete from slowtrace_cloud.receipts where run_id <> lease;

    if p_claim_jobs then
        update slowtrace_cloud.jobs set state = 'running', attempts = attempts + 1,
            run_id = lease, updated_at = clock_timestamp(), retry_at = null
            where id = (
                select id from slowtrace_cloud.jobs
                where state in ('queued', 'retry') and coalesce(retry_at, '-infinity') <= clock_timestamp()
                order by requested_at, id limit 1 for update skip locked
            ) returning * into job_row;
    end if;
    return jsonb_build_object(
        'lease_id', lease, 'checkpoint', worker_row.checkpoint,
        'job', case when job_row.id is not null then
            jsonb_build_object('job_id', job_row.id, 'ra', job_row.ra, 'dec', job_row.dec,
                'fov', job_row.fov, 'detector', job_row.detector, 'attempts', job_row.attempts)
        end
    );
end;
$$;

create or replace function public.slowtrace_worker_heartbeat(p_lease_id uuid, p_lease_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
    if p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
        raise exception 'Lease duration must be 60–900 seconds';
    end if;
    perform slowtrace_cloud.require_lease(p_lease_id);
    update slowtrace_cloud.worker set expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
        where singleton;
    return true;
end;
$$;

create or replace function slowtrace_cloud.product_record(p slowtrace_cloud.products)
returns jsonb language sql stable set search_path = '' as $$
    select to_jsonb(p) - array['run_id','created_at','center_ra','center_dec','detector'];
$$;

create or replace function public.slowtrace_worker_lookup(p_ids jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(slowtrace_cloud.product_record(p)), '[]')
    from slowtrace_cloud.products p
    join (select distinct value as id from jsonb_array_elements_text(p_ids) limit 200) i using (id);
$$;

create or replace function public.slowtrace_worker_pending(p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(slowtrace_cloud.product_record(p.product) order by p.created_at, p.id), '[]')
    from (
        select p as product, created_at, id from slowtrace_cloud.products p
        where state in ('retry', 'discovered') and coalesce(retry_at, '-infinity') <= now()
        order by created_at, id limit greatest(0, least(coalesce(p_limit, 10), 50))
    ) p;
$$;

create or replace function public.slowtrace_worker_neighbors(
    p_ra double precision, p_dec double precision, p_detector integer, p_limit integer
)
returns jsonb language sql stable security definer set search_path = '' as $$
    with nearby as (
        select p as product, p.id, distance.dot,
            row_number() over (
                partition by floor((p.metadata->>'mjd')::double precision / 14)
                order by distance.dot desc, coalesce((p.metadata->>'rank')::bigint, 0) desc, p.id
            ) as visit_rank
        from slowtrace_cloud.products p
        cross join lateral (
            select sin(radians(p_dec)) * sin(radians(p.center_dec))
                + cos(radians(p_dec)) * cos(radians(p.center_dec)) * cos(radians(p.center_ra - p_ra)) as dot
        ) distance
        where p_ra >= 0 and p_ra < 360 and p_dec between -90 and 90
            and p.state = 'preprocessed' and p.detector = p_detector
            and p.center_dec between p_dec - 6 and p_dec + 6
            and p.metadata->>'mjd' is not null
            and distance.dot >= cos(radians(6.0))
    ), selected as (
        select * from nearby where visit_rank <= 3 order by visit_rank, dot desc, id
        limit greatest(0, least(coalesce(p_limit, 30), 120))
    )
    select coalesce(jsonb_agg(slowtrace_cloud.product_record(product) order by visit_rank, dot desc, id), '[]')
    from selected;
$$;

create or replace function public.slowtrace_worker_groups(p_ids jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'state', g.state,
        'attempts', g.attempts, 'retry_at', g.retry_at)), '[]')
    from slowtrace_cloud.groups g
    join (select distinct value as id from jsonb_array_elements_text(p_ids) limit 200) i using (id);
$$;

create or replace function public.slowtrace_worker_lookup_groups(p_ids jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
    select public.slowtrace_worker_groups(p_ids);
$$;

create or replace function public.slowtrace_worker_pending_groups(p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(to_jsonb(g) - array['run_id','created_at','searched_at'] order by g.created_at, g.id), '[]')
    from (
        select * from slowtrace_cloud.groups
        where state in ('retry', 'compatible') and coalesce(retry_at, '-infinity') <= now()
        order by created_at, id limit greatest(0, least(coalesce(p_limit, 5), 25))
    ) g;
$$;

create or replace function public.slowtrace_worker_commit(
    p_lease_id uuid, p_commit_id uuid, p_checkpoint jsonb, p_products jsonb,
    p_groups jsonb, p_job jsonb, p_usage jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    entry jsonb;
    peak jsonb;
    product_row slowtrace_cloud.products%rowtype;
    previous_group_state text;
    previous_class text;
    new_class text;
    observation_was_preprocessed boolean;
    delta_discovered integer := 0;
    delta_preprocessed integer := 0;
    delta_compatible integer := 0;
    delta_searched integer := 0;
    delta_candidates integer := 0;
    delta_known integer := 0;
    delta_artifacts integer := 0;
    delta_unresolved integer := 0;
begin
    perform slowtrace_cloud.require_lease(p_lease_id);
    if exists (select 1 from slowtrace_cloud.receipts where run_id = p_lease_id and id = p_commit_id) then
        return jsonb_build_object('ok', true);
    end if;
    if slowtrace_cloud.storage_full() then
        update slowtrace_cloud.worker set storage_paused = true where singleton;
        return jsonb_build_object('ok', false, 'reason', 'storage_limit');
    end if;
    if p_commit_id is null or coalesce(jsonb_array_length(p_products), 0) > 1000
        or coalesce(jsonb_array_length(p_groups), 0) > 25
        or coalesce(octet_length(p_products::text), 0) + coalesce(octet_length(p_groups::text), 0) > 2000000
        or coalesce(octet_length(p_checkpoint::text), 0) > 8192
        or coalesce(octet_length(p_usage::text), 0) > 4096 then
        raise exception 'Worker submitted an oversized or invalid transaction';
    end if;

    for entry in select value from jsonb_array_elements(coalesce(p_products, '[]')) loop
        insert into slowtrace_cloud.products as dest
            (id, observation_id, release, version, metadata, state, attempts, retry_at, processed_at, run_id)
        values (
            entry->>'id', coalesce(entry->>'observation_id', entry->>'id'), entry->>'release', entry->>'version',
            coalesce(entry->'metadata', '{}'), entry->>'state', coalesce((entry->>'attempts')::integer, 0),
            (entry->>'retry_at')::timestamptz,
            case when entry->>'state' = 'preprocessed' then clock_timestamp() end, p_lease_id
        )
        on conflict (id) do update set
            metadata = dest.metadata || excluded.metadata,
            state = excluded.state,
            attempts = greatest(dest.attempts, excluded.attempts),
            retry_at = excluded.retry_at,
            processed_at = excluded.processed_at, run_id = excluded.run_id
        where dest.observation_id = excluded.observation_id and dest.release = excluded.release
            and dest.version = excluded.version and dest.state <> 'preprocessed'
            and (dest.state = 'discovered' or excluded.state <> 'discovered')
            and coalesce((dest.metadata->>'rank')::bigint, 0) <= coalesce((excluded.metadata->>'rank')::bigint, 0)
        returning * into product_row;
        if not found then continue; end if;

        select preprocessed into observation_was_preprocessed from slowtrace_cloud.observations
            where id = product_row.observation_id;
        if not found then
            insert into slowtrace_cloud.observations (id, preprocessed)
                values (product_row.observation_id, product_row.state = 'preprocessed');
            delta_discovered := delta_discovered + 1;
            if product_row.state = 'preprocessed' then delta_preprocessed := delta_preprocessed + 1; end if;
        elsif not observation_was_preprocessed and product_row.state = 'preprocessed' then
            update slowtrace_cloud.observations set preprocessed = true where id = product_row.observation_id;
            delta_preprocessed := delta_preprocessed + 1;
        end if;
    end loop;

    for entry in select value from jsonb_array_elements(coalesce(p_groups, '[]')) loop
        select state into previous_group_state from slowtrace_cloud.groups where id = entry->>'id';
        if previous_group_state = 'searched' then continue; end if;
        if exists (
            select 1 from jsonb_array_elements_text(entry->'product_ids') i
            where not exists (select 1 from slowtrace_cloud.products p where p.id = i.value and p.state = 'preprocessed')
        ) then
            raise exception 'Group references a product without committed preprocessing';
        end if;
        insert into slowtrace_cloud.groups as dest
            (id, algorithm, product_ids, metadata, state, attempts, retry_at, searched_at, run_id)
        values (
            entry->>'id', entry->>'algorithm', array(select jsonb_array_elements_text(entry->'product_ids')),
            coalesce(entry->'metadata', '{}'), coalesce(entry->>'state', 'compatible'), coalesce((entry->>'attempts')::integer, 0),
            (entry->>'retry_at')::timestamptz, case when entry->>'state' = 'searched' then clock_timestamp() end,
            p_lease_id
        )
        on conflict (id) do update set metadata = dest.metadata || excluded.metadata,
            state = excluded.state, attempts = greatest(dest.attempts, excluded.attempts),
            retry_at = excluded.retry_at, searched_at = excluded.searched_at, run_id = excluded.run_id
        where dest.product_ids = excluded.product_ids and dest.algorithm = excluded.algorithm
            and (dest.state <> 'blocked' or excluded.state = 'searched')
            and (dest.state = 'compatible' or excluded.state <> 'compatible');
        if not found then continue; end if;
        if previous_group_state is null then delta_compatible := delta_compatible + 1; end if;
        if entry->>'state' is distinct from 'searched' then continue; end if;

        delta_searched := delta_searched + 1;
        if coalesce(jsonb_array_length(entry->'candidates'), 0) > 50 then
            raise exception 'Worker submitted more than 50 candidates for one group';
        end if;
        for peak in select value from jsonb_array_elements(coalesce(entry->'candidates', '[]')) loop
            select classification into previous_class from slowtrace_cloud.candidates
                where id = peak->>'id' and group_id = entry->>'id';
            new_class := peak->>'classification';
            insert into slowtrace_cloud.candidates as dest (id, group_id, ra, dec, classification, evidence)
            values (peak->>'id', entry->>'id', (peak->>'ra')::double precision,
                (peak->>'dec')::double precision, new_class, coalesce(peak->'evidence', '{}'))
            on conflict (id) do update set ra = excluded.ra, dec = excluded.dec,
                classification = excluded.classification, evidence = excluded.evidence, updated_at = clock_timestamp()
            where dest.group_id = excluded.group_id;
            if not found then continue; end if;

            delta_candidates := delta_candidates + (new_class <> 'artifact')::integer
                - coalesce((previous_class <> 'artifact')::integer, 0);
            delta_known := delta_known + (new_class = 'known_match')::integer
                - coalesce((previous_class = 'known_match')::integer, 0);
            delta_artifacts := delta_artifacts + (new_class = 'artifact')::integer
                - coalesce((previous_class = 'artifact')::integer, 0);
            delta_unresolved := delta_unresolved + (new_class = 'unresolved')::integer
                - coalesce((previous_class = 'unresolved')::integer, 0);
        end loop;
    end loop;

    if p_job is not null and jsonb_typeof(p_job) <> 'null' then
        if p_job->>'state' is null or p_job->>'state' not in ('searched', 'insufficient', 'retry', 'blocked') then
            raise exception 'Invalid detection result state';
        end if;
        if p_job->>'state' = 'searched' and not exists (
            select 1 from slowtrace_cloud.groups where id = p_job->>'group_id' and state = 'searched'
        ) then
            raise exception 'Detection job must refer to a completed search';
        end if;
        update slowtrace_cloud.jobs set state = case
                when p_job->>'state' = 'retry' and attempts >= 3 then 'blocked' else p_job->>'state' end,
            group_id = p_job->>'group_id', message = left(p_job->>'message', 400),
            retry_at = case when p_job->>'state' = 'retry' and attempts < 3 then
                greatest(clock_timestamp() + interval '5 minutes', (p_job->>'retry_at')::timestamptz) end,
            updated_at = clock_timestamp()
        where id = (p_job->>'job_id')::uuid and run_id = p_lease_id and state = 'running';
        if not found then raise exception 'Detection job is not assigned to this lease'; end if;
    end if;

    update slowtrace_cloud.metrics set discovered = discovered + delta_discovered,
        preprocessed = preprocessed + delta_preprocessed, compatible_groups = compatible_groups + delta_compatible,
        searched_groups = searched_groups + delta_searched, moving_candidates = moving_candidates + delta_candidates,
        known_matches = known_matches + delta_known, rejected_artifacts = rejected_artifacts + delta_artifacts,
        unresolved_candidates = unresolved_candidates + delta_unresolved where singleton;
    if p_checkpoint is not null and jsonb_typeof(p_checkpoint) = 'object' then
        update slowtrace_cloud.worker set checkpoint = p_checkpoint, checkpoint_at = clock_timestamp()
            where singleton;
    end if;
    if jsonb_typeof(p_usage) = 'object' then
        update slowtrace_cloud.runs set usage = p_usage where id = p_lease_id;
    end if;
    insert into slowtrace_cloud.receipts (run_id, id) values (p_lease_id, p_commit_id);
    return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.slowtrace_worker_finish(
    p_lease_id uuid, p_status text, p_reason text, p_usage jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
    if p_status is null or p_status not in ('completed', 'paused', 'error')
        or coalesce(octet_length(p_usage::text), 0) > 4096 then
        raise exception 'Invalid worker outcome';
    end if;
    perform slowtrace_cloud.require_lease(p_lease_id);
    update slowtrace_cloud.runs set status = p_status, reason = left(p_reason, 400),
        finished_at = clock_timestamp(),
        usage = case when jsonb_typeof(p_usage) = 'object' then p_usage else usage end where id = p_lease_id;
    update slowtrace_cloud.jobs set state = case when attempts >= 3 then 'blocked' else 'retry' end,
        message = 'No result was committed before this session ended.',
        retry_at = case when attempts < 3 then clock_timestamp() + interval '5 minutes' end,
        updated_at = clock_timestamp() where run_id = p_lease_id and state = 'running';
    update slowtrace_cloud.worker set expires_at = null,
        last_successful_run = case when p_status = 'completed' then clock_timestamp() else last_successful_run end
        where singleton;
    return true;
end;
$$;

create or replace function public.slowtrace_survey_status()
returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'worker_status', case
            when w.storage_paused then 'storage_limit'
            when w.expires_at <= now() then 'interrupted'
            else coalesce(r.status, 'configured') end,
        'last_successful_run', w.last_successful_run,
        'latest_checkpoint', w.checkpoint_at,
        'metrics', (to_jsonb(m) - 'singleton') || jsonb_build_object('confirmed_discoveries', 0),
        'recent_candidates', (
            select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc, c.id), '[]')
            from (
                select id, group_id, ra, dec, classification, created_at, evidence
                from slowtrace_cloud.candidates order by created_at desc, id limit 8
            ) c
        ),
        'latest_run', case when r.id is not null then jsonb_build_object(
            'started_at', r.started_at, 'finished_at', r.finished_at,
            'status', case when w.expires_at <= now() then 'interrupted' else r.status end,
            'reason', r.reason, 'usage', r.usage
        ) end
    )
    from slowtrace_cloud.worker w cross join slowtrace_cloud.metrics m
    left join slowtrace_cloud.runs r on r.id = w.run_id
    where w.singleton and m.singleton;
$$;

create or replace function public.slowtrace_detection_result(p_job_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'job_id', j.id, 'ra', j.ra, 'dec', j.dec, 'fov', j.fov, 'detector', j.detector,
        'state', case when j.state = 'running' and w.expires_at <= now() then 'retry' else j.state end,
        'requested_at', j.requested_at, 'updated_at', j.updated_at,
        'attempts', j.attempts, 'retry_at', j.retry_at, 'message', j.message, 'group_id', j.group_id,
        'candidates', (
            select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc, c.id), '[]')
            from (
                select id, group_id, ra, dec, classification, created_at, evidence
                from slowtrace_cloud.candidates where group_id = j.group_id
                order by created_at desc, id limit 12
            ) c
        )
    )
    from slowtrace_cloud.jobs j cross join slowtrace_cloud.worker w
    where j.id = p_job_id and w.singleton;
$$;

create or replace function public.slowtrace_automatic_detection(
    p_ra double precision, p_dec double precision, p_fov double precision, p_detector integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    requester uuid := auth.uid();
    normalized_ra numeric;
    normalized_dec numeric;
    normalized_fov numeric;
    job_id uuid;
begin
    if requester is null or not exists (select 1 from slowtrace_cloud.owners o where o.user_id = requester) then
        raise exception 'An authorized survey owner must sign in to queue a detection.' using errcode = '42501';
    end if;
    if not coalesce(p_ra >= 0 and p_ra < 360 and p_dec between -90 and 90
        and p_fov between 2 and 30 and p_detector between 0 and 6, false) then
        raise exception 'Coordinates, field of view or detector are out of range.' using errcode = '22023';
    end if;
    normalized_ra := mod(round(p_ra::numeric, 6), 360);
    normalized_dec := round(p_dec::numeric, 6);
    normalized_fov := round(p_fov::numeric, 2);

    -- Serialize owner requests against the global queue cap, including concurrent tabs.
    perform pg_advisory_xact_lock(207573014, 1);
    select j.id into job_id from slowtrace_cloud.jobs j
    where j.ra = normalized_ra and j.dec = normalized_dec and j.fov = normalized_fov
        and j.detector = p_detector and (j.state in ('queued', 'running', 'retry')
            or (j.state in ('searched', 'insufficient') and j.requested_at >= now() - interval '7 days'))
    order by j.requested_at desc limit 1;
    if job_id is not null then return public.slowtrace_detection_result(job_id); end if;

    if slowtrace_cloud.storage_full() then
        raise exception 'The survey database reached its storage target.';
    end if;
    if (select count(*) from slowtrace_cloud.jobs where state in ('queued', 'running', 'retry')) >= 4 then
        raise exception 'The detection queue is full. Wait for the next Kaggle session.';
    end if;
    if (select count(*) from slowtrace_cloud.jobs j where j.owner_id = requester
            and j.requested_at >= now() - interval '24 hours') >= 2 then
        raise exception 'The owner may queue two new fields per 24 hours.';
    end if;
    insert into slowtrace_cloud.jobs (owner_id, ra, dec, fov, detector)
    values (requester, normalized_ra, normalized_dec, normalized_fov, p_detector) returning id into job_id;
    return public.slowtrace_detection_result(job_id);
end;
$$;

revoke all on all functions in schema slowtrace_cloud from public, anon, authenticated, service_role;
revoke all on function
    public.slowtrace_worker_acquire(integer, boolean),
    public.slowtrace_worker_heartbeat(uuid, integer),
    public.slowtrace_worker_lookup(jsonb),
    public.slowtrace_worker_pending(integer),
    public.slowtrace_worker_neighbors(double precision, double precision, integer, integer),
    public.slowtrace_worker_groups(jsonb),
    public.slowtrace_worker_lookup_groups(jsonb),
    public.slowtrace_worker_pending_groups(integer),
    public.slowtrace_worker_commit(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb),
    public.slowtrace_worker_finish(uuid, text, text, jsonb),
    public.slowtrace_survey_status(),
    public.slowtrace_detection_result(uuid),
    public.slowtrace_automatic_detection(double precision, double precision, double precision, integer)
from public, anon, authenticated, service_role;

grant execute on function
    public.slowtrace_worker_acquire(integer, boolean),
    public.slowtrace_worker_heartbeat(uuid, integer),
    public.slowtrace_worker_lookup(jsonb),
    public.slowtrace_worker_pending(integer),
    public.slowtrace_worker_neighbors(double precision, double precision, integer, integer),
    public.slowtrace_worker_groups(jsonb),
    public.slowtrace_worker_lookup_groups(jsonb),
    public.slowtrace_worker_pending_groups(integer),
    public.slowtrace_worker_commit(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb),
    public.slowtrace_worker_finish(uuid, text, text, jsonb)
to service_role;

grant execute on function public.slowtrace_survey_status(), public.slowtrace_detection_result(uuid)
to anon, authenticated;
grant execute on function public.slowtrace_automatic_detection(double precision, double precision, double precision, integer)
to authenticated;

notify pgrst, 'reload schema';
commit;
