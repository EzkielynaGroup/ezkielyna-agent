// Linux sandbox argv (runs everywhere, no bwrap needed): unix sockets under /run must be hidden (review round 2, M-2).
import { describe, expect, test } from "bun:test"
import { bwrapArgs } from "../../src/ezk/sandbox/bwrap"

const base = { bwrap: "/usr/bin/bwrap", writable: ["/work"], protectedNames: [".git"], cwd: "/work", exists: () => false }
const at = (args: string[], ...seq: string[]) => args.findIndex((_, i) => seq.every((s, j) => args[i + j] === s))

describe("bwrap argv hides unix sockets", () => {
  test("empty tmpfs on /run, docker and containerd masked, network still unshared", () => {
    const args = bwrapArgs({ ...base, network: false })
    expect(at(args, "--tmpfs", "/run")).toBeGreaterThan(at(args, "--ro-bind", "/", "/"))
    expect(at(args, "--ro-bind", "/dev/null", "/run/docker.sock")).toBeGreaterThan(-1)
    expect(at(args, "--tmpfs", "/run/containerd")).toBeGreaterThan(-1)
    expect(args).toContain("--unshare-net")
    expect(args).not.toContain("--ro-bind-try") // no DNS stub without network
  })
  test("a real /var/run/docker.sock is masked in place when it exists", () => {
    const args = bwrapArgs({ ...base, network: false, exists: (f) => f === "/var/run/docker.sock" })
    expect(at(args, "--ro-bind", "/dev/null", "/var/run/docker.sock")).toBeGreaterThan(-1)
    expect(at(bwrapArgs({ ...base, network: false }), "--ro-bind", "/dev/null", "/var/run/docker.sock")).toBe(-1)
  })
  test("the tmpfs comes before the writable binds (a writable root under /run still works) and with network the DNS stub stays", () => {
    const args = bwrapArgs({ ...base, writable: ["/run/user/1000/work"], network: true })
    expect(at(args, "--tmpfs", "/run")).toBeLessThan(at(args, "--bind", "/run/user/1000/work", "/run/user/1000/work"))
    expect(at(args, "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve")).toBeGreaterThan(at(args, "--tmpfs", "/run"))
    expect(args).not.toContain("--unshare-net")
  })
})
