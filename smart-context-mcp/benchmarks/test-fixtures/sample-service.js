/**
 * Sample service for testing v2 editor operations
 * This file demonstrates typical edit patterns and edge cases
 */
export class UserService {
    logger;
    users = new Map();
    activeCount = 0;
    constructor(logger) {
        this.logger = logger;
    }
    async getUser(id) {
        return this.users.get(id) || null;
    }
    async createUser(data) {
        const user = {
            id: Math.random().toString(36).slice(2),
            name: data.name,
            email: data.email,
        };
        this.users.set(user.id, user);
        this.activeCount++;
        return user;
    }
    async updateUser(id, data) {
        const user = this.users.get(id);
        if (!user) {
            throw new Error(`User ${id} not found`);
        }
        Object.assign(user, data);
        return user;
    }
    getActiveCount() {
        return this.activeCount;
    }
}
