import { useStore, setState as _set } from './store';

type Dict = Record<string, string>;

const en: Dict = {
  'nav.new': 'New agent',
  'nav.skills': 'Skills',
  'nav.messaging': 'Messaging',
  'nav.artifacts': 'Artifacts',
  'nav.automations': 'Automations',
  'nav.memory': 'Memory',
  'nav.insights': 'Insights',
  'nav.pinned': 'Pinned',
  'nav.agents': 'Agents',
  'nav.pinHint': 'Shift-click a chat to pin it',
  'nav.search': 'Search chats…',
  'chat.placeholder': 'Ask Kronos anything…',
  'chat.followup': 'Send follow-up',
  'chat.queued': 'Queued',
  'chat.thinking': 'Thinking',
  'chat.working': 'Working',
  'chat.stop': 'Stop',
  'chat.welcome': 'What should we work on?',
  'chat.welcomeSub': 'Kronos can code, research, automate, remember and act across your tools and chat apps.',
  'chat.demo': 'Demo mode — no API key yet. Kronos is using an offline scripted model.',
  'chat.addKey': 'Add an API key',
  'chat.approval': 'Approval needed',
  'chat.allow': 'Allow',
  'chat.allowSession': 'Allow for session',
  'chat.allowAlways': 'Always allow',
  'chat.deny': 'Deny',
  'chat.feedback': 'Optional feedback for Kronos…',
  'chat.question': 'Kronos has a question',
  'chat.answer': 'Your answer…',
  'chat.send': 'Send',
  'chat.compacted': 'Conversation compacted',
  'chat.plan': 'Plan',
  'status.gateway': 'Gateway',
  'status.ready': 'ready',
  'status.offline': 'offline',
  'status.running': 'running',
  'status.cron': 'Cron',
  'status.session': 'Session',
  'settings.title': 'Settings',
  'settings.search': 'Search settings…',
  'settings.noMatch': 'No matching settings',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.rename': 'Rename',
  'common.export': 'Export',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.configured': 'Configured',
  'common.needsKeys': 'Needs keys',
  'common.all': 'All',
  'common.refresh': 'Refresh',
  'common.add': 'Add',
  'common.new': 'New',
  'common.run': 'Run now',
  'common.edit': 'Edit',
  'common.close': 'Close',
  'common.install': 'Install',
  'skills.search': 'Search skills…',
  'skills.toolsets': 'Toolsets',
  'skills.enabledCount': '{n}/{m} toolsets enabled',
  'artifacts.search': 'Search artifacts…',
  'artifacts.images': 'Images',
  'artifacts.files': 'Files',
  'artifacts.links': 'Links',
  'profiles.title': 'Profiles',
  'profiles.desc': 'Separate personas with their own config, memory, skills and SOUL.md.',
  'profiles.manage': 'Manage profiles',
  'palette.placeholder': 'Type a command or search…',
};

const tr: Dict = {
  'nav.new': 'Yeni ajan',
  'nav.skills': 'Yetenekler',
  'nav.messaging': 'Mesajlaşma',
  'nav.artifacts': 'Çıktılar',
  'nav.automations': 'Otomasyonlar',
  'nav.memory': 'Hafıza',
  'nav.insights': 'İçgörüler',
  'nav.pinned': 'Sabitlenenler',
  'nav.agents': 'Ajanlar',
  'nav.pinHint': 'Sabitlemek için Shift ile tıklayın',
  'nav.search': 'Sohbetlerde ara…',
  'chat.placeholder': "Kronos'a her şeyi sorun…",
  'chat.followup': 'Devam mesajı gönder',
  'chat.queued': 'Sırada',
  'chat.thinking': 'Düşünüyor',
  'chat.working': 'Çalışıyor',
  'chat.stop': 'Durdur',
  'chat.welcome': 'Bugün ne üzerinde çalışalım?',
  'chat.welcomeSub': 'Kronos kod yazar, araştırır, otomatikleştirir, hatırlar ve araçlarınızla sohbet uygulamalarınızda iş yapar.',
  'chat.demo': 'Demo modu — henüz API anahtarı yok. Kronos çevrimdışı demo modelini kullanıyor.',
  'chat.addKey': 'API anahtarı ekle',
  'chat.approval': 'Onay gerekiyor',
  'chat.allow': 'İzin ver',
  'chat.allowSession': 'Bu oturumda izin ver',
  'chat.allowAlways': 'Her zaman izin ver',
  'chat.deny': 'Reddet',
  'chat.feedback': "Kronos'a isteğe bağlı geri bildirim…",
  'chat.question': "Kronos'un bir sorusu var",
  'chat.answer': 'Cevabınız…',
  'chat.send': 'Gönder',
  'chat.compacted': 'Sohbet sıkıştırıldı',
  'chat.plan': 'Plan',
  'status.gateway': 'Ağ geçidi',
  'status.ready': 'hazır',
  'status.offline': 'çevrimdışı',
  'status.running': 'çalışıyor',
  'status.cron': 'Zamanlayıcı',
  'status.session': 'Oturum',
  'settings.title': 'Ayarlar',
  'settings.search': 'Ayarlarda ara…',
  'settings.noMatch': 'Eşleşen ayar yok',
  'common.save': 'Kaydet',
  'common.cancel': 'İptal',
  'common.delete': 'Sil',
  'common.rename': 'Yeniden adlandır',
  'common.export': 'Dışa aktar',
  'common.copy': 'Kopyala',
  'common.copied': 'Kopyalandı',
  'common.enabled': 'Açık',
  'common.disabled': 'Kapalı',
  'common.configured': 'Yapılandırıldı',
  'common.needsKeys': 'Anahtar gerekli',
  'common.all': 'Tümü',
  'common.refresh': 'Yenile',
  'common.add': 'Ekle',
  'common.new': 'Yeni',
  'common.run': 'Şimdi çalıştır',
  'common.edit': 'Düzenle',
  'common.close': 'Kapat',
  'common.install': 'Yükle',
  'skills.search': 'Yeteneklerde ara…',
  'skills.toolsets': 'Araç setleri',
  'skills.enabledCount': '{n}/{m} araç seti açık',
  'artifacts.search': 'Çıktılarda ara…',
  'artifacts.images': 'Görseller',
  'artifacts.files': 'Dosyalar',
  'artifacts.links': 'Bağlantılar',
  'profiles.title': 'Profiller',
  'profiles.desc': 'Kendi ayarları, hafızası, yetenekleri ve SOUL.md dosyası olan ayrı kişilikler.',
  'profiles.manage': 'Profilleri yönet',
  'palette.placeholder': 'Komut yazın veya arayın…',
};

const dicts: Record<string, Dict> = { en, tr };

function detect(): string {
  try {
    const saved = localStorage.getItem('kronos.lang');
    if (saved) return JSON.parse(saved);
  } catch {
    /* ignore */
  }
  return navigator.language?.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

let lang = detect();

export function getLang(): string {
  return lang;
}

export function setLang(l: string): void {
  lang = dicts[l] ? l : 'en';
  try {
    localStorage.setItem('kronos.lang', JSON.stringify(lang));
  } catch {
    /* ignore */
  }
  _set((s) => ({ configVersion: s.configVersion + 1 }));
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const s = dicts[lang]?.[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

/** Re-render on language change. */
export function useLang(): string {
  useStore((s) => s.configVersion);
  return lang;
}

export const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'tr', label: 'Türkçe' },
];
