/**
 * Sample service for testing v2 editor operations
 * This file demonstrates typical edit patterns and edge cases
 */

interface User {
  id: string;
  name: string;
  email: string;
}

interface UserData {
  name: string;
  email: string;
}

interface Logger {
  log(message: string): void;
}

export class UserService {
  private users: Map<string, User> = new Map();
  private activeCount = 0;

  constructor(private logger: Logger) {}

  async getUser(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async createUser(data: UserData): Promise<User> {
    const user: User = {
      id: Math.random().toString(36).slice(2),
      name: data.name,
      email: data.email,
    };
    this.users.set(user.id, user);
    this.activeCount++;
    return user;
  }

  async updateUser(id: string, data: Partial<UserData>): Promise<User> {
    const user = this.users.get(id);
    if (!user) {
      throw new Error(`User ${id} not found`);
    }
    Object.assign(user, data);
    return user;
  }

  getActiveCount(): number {
    return this.activeCount;
  }
}
