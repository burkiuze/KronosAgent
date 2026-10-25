import { useEffect, useState, type ReactNode } from 'react';
import { Check, Plus, Trash2, UserRound } from 'lucide-react';
import { del, get, post } from '../lib/api';
import { toast, useStore } from '../lib/store';
import { t } from '../lib/i18n';
import { Field, Menu, Modal } from './ui';

interface Profile {
  name: string;
  active: boolean;
  dir: string;
  soul: string;
}

function ManageProfiles({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [name, setName] = useState('');
  const [soul, setSoul] = useState('');
  const [copy, setCopy] = useState(true);
  const load = () => void get<Profile[]>('/api/profiles').then(setProfiles);
  useEffect(load, []);
  return (
    <Modal open onClose={onClose} wide>
      <h2>{t('profiles.title')}</h2>
      <p className="muted">{t('profiles.desc')}</p>
      <div className="profile-list">
        {profiles.map((p) => (
          <div key={p.name} className={`list-row ${p.active ? 'active' : ''}`}>
            <UserRound size={16} />
            <div className="list-main">
              <div className="list-title">
                {p.name} {p.active && <span className="tag ok">active</span>}
              </div>
              <div className="list-desc">{p.soul ? p.soul.split('\n')[0] : p.dir}</div>
            </div>
            {!p.active && (
              <button
                className="btn small"
                onClick={async () => {
                  await post(`/api/profiles/${p.name}/activate`);
                  load();
                  onClose();
                }}
              >
                Switch
              </button>
            )}
            {!p.active && p.name !== 'default' && (
              <button
                className="icon-btn tiny"
                onClick={async () => {
                  if (!confirm(`Delete profile ${p.name} and all its data?`)) return;
                  await del(`/api/profiles/${p.name}`);
                  load();
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <h4 className="list-cat">New profile</h4>
      <div className="grid2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="work, research, family-bot…" />
        </Field>
        <Field label="Start from current skills & memory">
          <select value={copy ? 'yes' : 'no'} onChange={(e) => setCopy(e.target.value === 'yes')}>
            <option value="yes">Copy from active profile</option>
            <option value="no">Start empty</option>
          </select>
        </Field>
      </div>
      <Field label="Persona (SOUL.md)">
        <textarea rows={4} value={soul} onChange={(e) => setSoul(e.target.value)} placeholder="You are a meticulous research assistant who always cites sources." />
      </Field>
      <div className="modal-actions">
        <div className="flex-1" />
        <button
          className="btn primary"
          disabled={!name}
          onClick={async () => {
            try {
              const active = profiles.find((p) => p.active)?.name;
              await post('/api/profiles', { name, soul: soul || undefined, copyFrom: copy ? active : undefined });
              toast(`Profile ${name} created`);
              setName('');
              setSoul('');
              load();
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          <Plus size={13} /> Create
        </button>
      </div>
    </Modal>
  );
}

export function ProfilesMenu({ trigger }: { trigger: (open: () => void) => ReactNode }) {
  const status = useStore((s) => s.status);
  const [manage, setManage] = useState(false);
  return (
    <>
      <Menu align="right" trigger={trigger}>
        {(close) => (
          <div className="profiles-pop">
            <div className="profiles-title">{t('profiles.title')}</div>
            <div className="profiles-desc">{t('profiles.desc')}</div>
            {(status?.profiles ?? ['default']).map((p) => (
              <button
                key={p}
                className="menu-item"
                onClick={async () => {
                  close();
                  if (p !== status?.profile) await post(`/api/profiles/${p}/activate`);
                }}
              >
                <UserRound size={14} />
                <span>{p}</span>
                {p === status?.profile && <Check size={14} />}
              </button>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => (close(), setManage(true))}>
              <UserRound size={14} />
              <span>{t('profiles.manage')}</span>
            </button>
          </div>
        )}
      </Menu>
      {manage && <ManageProfiles onClose={() => setManage(false)} />}
    </>
  );
}
