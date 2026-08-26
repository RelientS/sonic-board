export class LiveSessionController<Config, Session> {
  private generation = 0;
  private activeSession: Session | null = null;
  private wantsPlayback = false;
  private readonly createSession: (config: Config) => Promise<Session>;
  private readonly disposeSession: (session: Session) => Promise<void>;

  constructor(
    createSession: (config: Config) => Promise<Session>,
    disposeSession: (session: Session) => Promise<void>,
  ) {
    this.createSession = createSession;
    this.disposeSession = disposeSession;
  }

  get current() {
    return this.activeSession;
  }

  get requested() {
    return this.wantsPlayback;
  }

  async start(config: Config) {
    const generation = ++this.generation;
    this.wantsPlayback = true;
    const previous = this.activeSession;
    this.activeSession = null;
    if (previous) await this.disposeSession(previous);
    if (generation !== this.generation || !this.wantsPlayback) return null;

    let session: Session;
    try {
      session = await this.createSession(config);
    } catch (error) {
      if (generation !== this.generation || !this.wantsPlayback) return null;
      this.wantsPlayback = false;
      throw error;
    }

    if (generation !== this.generation || !this.wantsPlayback) {
      await this.disposeSession(session);
      return null;
    }
    this.activeSession = session;
    return session;
  }

  async stop() {
    this.wantsPlayback = false;
    this.generation += 1;
    const session = this.activeSession;
    this.activeSession = null;
    if (session) await this.disposeSession(session);
  }

  async dispose() {
    await this.stop();
  }
}
