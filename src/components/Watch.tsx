import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import { useMemo, useRef } from "react";
import {
  LocalMediaStorage,
  MediaPlayer,
  MediaProvider,
  type MediaPlayerInstance,
  type Src,
} from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";

// Позицию помним по серии, а не по ссылке: при смене качества URL другой.
class EpisodeStorage extends LocalMediaStorage {
  constructor(private key: string) {
    super();
  }
  override onChange(src: Src, _mediaId: string | null, playerId?: string) {
    super.onChange(src, this.key, playerId);
  }
}

const RU = {
  Announcements: "Объявления",
  Accessibility: "Доступность",
  Audio: "Звук",
  Auto: "Авто",
  Boost: "Усиление",
  Captions: "Субтитры",
  "Caption Styles": "Стиль субтитров",
  "Captions look like this": "Так выглядят субтитры",
  Chapters: "Главы",
  "Closed-Captions Off": "Субтитры выкл.",
  "Closed-Captions On": "Субтитры вкл.",
  Connected: "Подключено",
  Continue: "Продолжить",
  Connecting: "Подключение",
  Default: "По умолчанию",
  Disabled: "Выключено",
  Disconnected: "Отключено",
  "Display Background": "Фон экрана",
  Download: "Скачать",
  "Enter Fullscreen": "На весь экран",
  "Enter PiP": "Картинка в картинке",
  "Exit Fullscreen": "Выйти из полноэкранного режима",
  "Exit PiP": "Закрыть картинку в картинке",
  Font: "Шрифт",
  Family: "Семейство",
  Fullscreen: "Полный экран",
  "Keyboard Animations": "Анимации клавиш",
  Loop: "Повтор",
  Mute: "Выключить звук",
  Normal: "Обычная",
  Off: "Выкл.",
  Pause: "Пауза",
  Play: "Смотреть",
  Playback: "Воспроизведение",
  PiP: "Картинка в картинке",
  Quality: "Качество",
  Replay: "Сначала",
  Reset: "Сбросить",
  "Seek Backward": "Назад",
  "Seek Forward": "Вперёд",
  Seek: "Перемотка",
  Settings: "Настройки",
  Speed: "Скорость",
  Size: "Размер",
  Color: "Цвет",
  Opacity: "Прозрачность",
  Shadow: "Тень",
  Text: "Текст",
  "Text Background": "Фон текста",
  Track: "Дорожка",
  Unmute: "Включить звук",
  Volume: "Громкость",
};

export default function Watch({
  src,
  title,
  storageKey,
  onWatched,
  onEnded,
}: {
  src: string;
  title: string;
  storageKey: string;
  onWatched: () => void;
  onEnded: () => void;
}) {
  const player = useRef<MediaPlayerInstance>(null);
  const storage = useMemo(() => new EpisodeStorage(storageKey), [storageKey]);
  const marked = useRef(false);

  return (
    <MediaPlayer
      ref={player}
      className="player"
      src={{ src, type: "video/mp4" }}
      title={title}
      storage={storage}
      playsInline
      autoPlay
      onTimeUpdate={({ currentTime }) => {
        const duration = player.current?.state.duration ?? 0;
        if (marked.current || duration <= 0 || currentTime / duration < 0.9) return;
        marked.current = true;
        onWatched();
      }}
      onEnded={onEnded}
    >
      <MediaProvider />
      <DefaultVideoLayout
        icons={defaultLayoutIcons}
        translations={RU}
        slots={{ googleCastButton: null, airPlayButton: null }}
      />
    </MediaPlayer>
  );
}
