type P = { size?: number };
const base = (size = 16) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const Play = ({ size }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
);
export const Download = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" />
  </svg>
);
export const Plus = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const Back = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
export const Gear = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-2.7 1.13V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.8 19.4l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 3 15a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.6 8.8l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 10 4.6V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.13l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 21 11a2 2 0 0 1 0 4h-.1" />
  </svg>
);
export const X = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const Check = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </svg>
);
export const Trash = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" />
  </svg>
);
export const Folder = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);
export const Refresh = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M20 11a8 8 0 1 0-.6 4M20 5v6h-6" />
  </svg>
);
export const ExternalLink = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M15 3h6v6" />
    <path d="M10 14L21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
);
export const Prev = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M18 6 9 12l9 6zM6 6v12" />
  </svg>
);
export const Next = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="m6 6 9 6-9 6zM18 6v12" />
  </svg>
);
export const Screen = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16.5V20" />
  </svg>
);
