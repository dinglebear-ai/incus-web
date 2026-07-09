export type BuilderDistroId = "debian" | "ubuntu" | "alpine" | "fedora" | "rocky";

export type BuilderDistroRelease = {
  id: string;
  label: string;
  source: {
    downloader: string;
    url: string;
    keys?: string[];
    keyserver?: string;
    components?: string[];
  };
  packageManager: "apt" | "apk" | "dnf";
};

export type BuilderDistro = {
  id: BuilderDistroId;
  label: string;
  releases: BuilderDistroRelease[];
};

export const BUILDER_DISTROS: BuilderDistro[] = [
  {
    id: "debian",
    label: "Debian",
    releases: [
      {
        id: "trixie",
        label: "Trixie",
        packageManager: "apt",
        source: {
          downloader: "debootstrap",
          url: "http://deb.debian.org/debian",
          keyserver: "keyserver.ubuntu.com",
          keys: ["0xA4285295FC7B1A81600062A9605C66F00D6C9793"],
          components: ["main"],
        },
      },
      {
        id: "bookworm",
        label: "Bookworm",
        packageManager: "apt",
        source: {
          downloader: "debootstrap",
          url: "http://deb.debian.org/debian",
          keyserver: "keyserver.ubuntu.com",
          keys: ["0xB8B80B5B623EAB6AD8775C45B7C5D7D6350947F8"],
          components: ["main"],
        },
      },
    ],
  },
  {
    id: "ubuntu",
    label: "Ubuntu",
    releases: [
      {
        id: "noble",
        label: "24.04 Noble",
        packageManager: "apt",
        source: {
          downloader: "ubuntu-http",
          url: "http://archive.ubuntu.com/ubuntu",
          keyserver: "keyserver.ubuntu.com",
          keys: ["0x871920D1991BC93C"],
        },
      },
      {
        id: "jammy",
        label: "22.04 Jammy",
        packageManager: "apt",
        source: {
          downloader: "ubuntu-http",
          url: "http://archive.ubuntu.com/ubuntu",
          keyserver: "keyserver.ubuntu.com",
          keys: ["0x871920D1991BC93C"],
        },
      },
    ],
  },
  {
    id: "alpine",
    label: "Alpine",
    releases: [
      {
        id: "3.20",
        label: "3.20",
        packageManager: "apk",
        source: {
          downloader: "alpinelinux-http",
          url: "http://dl-cdn.alpinelinux.org/alpine",
        },
      },
    ],
  },
  {
    id: "fedora",
    label: "Fedora",
    releases: [
      {
        id: "40",
        label: "40",
        packageManager: "dnf",
        source: {
          downloader: "fedora-http",
          url: "https://download.fedoraproject.org/pub/fedora/linux",
        },
      },
    ],
  },
  {
    id: "rocky",
    label: "Rocky Linux",
    releases: [
      {
        id: "9",
        label: "9",
        packageManager: "dnf",
        source: {
          downloader: "rockylinux-http",
          url: "https://dl.rockylinux.org/pub/rocky",
        },
      },
    ],
  },
];

export function findBuilderRelease(distro: string, release: string) {
  const distroEntry = BUILDER_DISTROS.find((entry) => entry.id === distro);
  return distroEntry?.releases.find((entry) => entry.id === release);
}
