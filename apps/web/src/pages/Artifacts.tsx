import { useEffect, useState } from 'react';
import { ExternalLink, FileText, Image as ImageIcon, Link2, RefreshCw, Trash2, Download } from 'lucide-react';
import { artifactUrl, del, get } from '../lib/api';
import { openSession, useStore } from '../lib/store';
import { t } from '../lib/i18n';
import type { Artifact } from '../lib/types';
import { Empty, Modal, SearchBox, Tabs } from '../components/ui';
import { highlightCode, langFromPath, renderMarkdown } from '../lib/markdown';

function Preview({ a, onClose }: { a: Artifact; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (a.kind === 'file') {
      void fetch(artifactUrl(a.id))
        .then(async (r) => (r.ok && /text|json|javascript|xml|yaml|markdown|csv/.test(r.headers.get('content-type') ?? '') ? r.text() : null))
        .then(setText)
        .catch(() => setText(null));
    }
  }, [a.id]);
  return (
    <Modal open onClose={onClose} wide>
      <div className="artifact-preview">
        <h2>{a.title}</h2>
        <div className="muted small">{a.location}</div>
        {a.kind === 'image' && <img src={artifactUrl(a.id)} alt={a.title} />}
        {a.kind === 'file' &&
          (text === null ? (
            <div className="muted pad">No inline preview for this file type.</div>
          ) : /\.md$/i.test(a.location) ? (
            <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
          ) : (
            <pre className="file-code">
              <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(text.slice(0, 200_000), langFromPath(a.location)) }} />
            </pre>
          ))}
        <div className="modal-actions">
          {a.sessionId && (
            <button className="btn" onClick={() => (onClose(), openSession(a.sessionId))}>
              Open conversation
            </button>
          )}
          <div className="flex-1" />
          <a className="btn primary" href={artifactUrl(a.id, true)}>
            <Download size={13} /> Download
          </a>
        </div>
      </div>
    </Modal>
  );
}

export function ArtifactsPage() {
  const [items, setItems] = useState<Artifact[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [kind, setKind] = useState<'all' | 'image' | 'file' | 'link'>('all');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<Artifact | null>(null);
  useStore((s) => s.configVersion);
  const load = () =>
    void get<{ items: Artifact[]; counts: Record<string, number> }>(`/api/artifacts${kind === 'all' ? '' : `?kind=${kind}`}`).then((r) => {
      setItems(r.items);
      setCounts(r.counts);
    });
  useEffect(load, [kind]);
  const q = query.toLowerCase();
  const shown = items.filter((a) => !q || `${a.title} ${a.location} ${a.sessionTitle}`.toLowerCase().includes(q));
  const Icon = ({ k }: { k: string }) => (k === 'image' ? <ImageIcon size={14} /> : k === 'link' ? <Link2 size={14} /> : <FileText size={14} />);
  return (
    <div className="page">
      <div className="page-top">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('artifacts.search')}
          right={
            <button className="icon-btn tiny" onClick={load} title={t('common.refresh')}>
              <RefreshCw size={13} />
            </button>
          }
        />
        <Tabs
          value={kind}
          onChange={setKind}
          tabs={[
            { id: 'all', label: t('common.all'), count: counts.all ?? 0 },
            { id: 'image', label: t('artifacts.images'), count: counts.image ?? 0 },
            { id: 'file', label: t('artifacts.files'), count: counts.file ?? 0 },
            { id: 'link', label: t('artifacts.links'), count: counts.link ?? 0 },
          ]}
        />
      </div>
      <div className="page-body">
        {shown.length ? (
          <>
            <div className="table-meta muted small">
              {shown.length} of {counts.all ?? shown.length} items
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Title / name</th>
                  <th>Location</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id} onClick={() => (a.kind === 'link' ? window.open(a.location, '_blank') : setPreview(a))}>
                    <td>
                      <span className="cell-title">
                        <span className="cell-icon">
                          <Icon k={a.kind} />
                        </span>
                        {a.title}
                        {a.kind === 'link' && <ExternalLink size={11} className="muted" />}
                      </span>
                    </td>
                    <td className="mono muted">{a.location.replace(/^https?:\/\//, '').replace(/^\/home\/[^/]+|^\/Users\/[^/]+/, '~')}</td>
                    <td>
                      <div className="cell-source">{a.sessionTitle ?? '—'}</div>
                      <div className="muted small">{new Date(a.createdAt).toLocaleString()}</div>
                    </td>
                    <td>
                      <button
                        className="icon-btn tiny"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await del(`/api/artifacts/${a.id}`);
                          load();
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <Empty icon={<FileText size={28} />} title="No artifacts yet">
            Files Kronos writes, images it generates and pages it reads show up here.
          </Empty>
        )}
      </div>
      {preview && <Preview a={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
