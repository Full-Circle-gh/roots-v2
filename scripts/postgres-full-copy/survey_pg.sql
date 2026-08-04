\pset pager off
\pset format unaligned
\pset fieldsep '\t'
\pset tuples_only on

\echo ===TABLES===
select c.relname,
       (select count(*) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' order by c.relname;

\echo ===COLUMNS===
select c.relname, a.attnum, a.attname, format_type(a.atttypid,a.atttypmod), a.attnotnull,
       coalesce(pg_get_expr(d.adbin,d.adrelid),''), a.attidentity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
     join pg_attribute a on a.attrelid=c.oid
     left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped
order by c.relname, a.attnum;

\echo ===FKEYS===
select con.conrelid::regclass::text, con.confrelid::regclass::text, pg_get_constraintdef(con.oid)
from pg_constraint con join pg_namespace n on n.oid=con.connamespace
where n.nspname='public' and con.contype='f'
order by 1,2;

\echo ===SEQUENCES===
select s.relname, pg_get_serial_sequence(quote_ident(t.relname), a.attname)
from pg_class s join pg_namespace n on n.oid=s.relnamespace
     left join pg_depend d on d.objid=s.oid and d.deptype='a'
     left join pg_class t on t.oid=d.refobjid
     left join pg_attribute a on a.attrelid=t.oid and a.attnum=d.refobjsubid
where n.nspname='public' and s.relkind='S' order by s.relname;

\echo ===UNIQUE_AND_CHECK===
select con.conrelid::regclass::text, con.contype, pg_get_constraintdef(con.oid)
from pg_constraint con join pg_namespace n on n.oid=con.connamespace
where n.nspname='public' and con.contype in ('u','c','p')
order by 1,2;

\echo ===ROWCOUNTS_NONZERO===
select relname, n_live_tup from pg_stat_user_tables where n_live_tup>0 order by relname;
