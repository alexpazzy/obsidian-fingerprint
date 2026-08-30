import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TouchIDLockPlugin from "./main";
import { generateSalt, hashPassword } from "./crypto";

export interface TouchIDLockSettings {
	lockOnStartup: boolean;
	lockOnBlur: boolean;
	lockOnBlurDelaySeconds: number;
	lockOnIdle: boolean;
	lockOnIdleDelaySeconds: number;
	touchIdReason: string;
	passwordFallbackEnabled: boolean;
	passwordSalt: string;
	passwordHash: string;
}

export const DEFAULT_SETTINGS: TouchIDLockSettings = {
	lockOnStartup: true,
	lockOnBlur: true,
	lockOnBlurDelaySeconds: 30,
	lockOnIdle: false,
	lockOnIdleDelaySeconds: 300,
	touchIdReason: "unlock your Obsidian vault",
	passwordFallbackEnabled: false,
	passwordSalt: "",
	passwordHash: "",
};

function clampSeconds(value: string): number {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.min(n, 24 * 60 * 60);
}

export class TouchIDLockSettingTab extends PluginSettingTab {
	plugin: TouchIDLockPlugin;
	private pendingPassword = "";

	constructor(app: App, plugin: TouchIDLockPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Obsidian Fingerprint" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"This is a screen lock, not encryption \u2014 your notes are never modified or encrypted on " +
				"disk. It hides the Obsidian interface and requires Touch ID (or a fallback password) to see " +
				"it again.",
		});

		new Setting(containerEl)
			.setName("Lock on startup")
			.setDesc("Show the lock screen immediately whenever Obsidian opens this vault.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.lockOnStartup).onChange(async (v) => {
					this.plugin.settings.lockOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Lock when Obsidian loses focus")
			.setDesc("Lock after the app has been in the background for the delay below.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.lockOnBlur).onChange(async (v) => {
					this.plugin.settings.lockOnBlur = v;
					await this.plugin.saveSettings();
					this.plugin.resetBlurWatcher();
					this.display();
				})
			);

		if (this.plugin.settings.lockOnBlur) {
			new Setting(containerEl)
				.setName("Lock-on-blur delay (seconds)")
				.setDesc("How long Obsidian can sit unfocused before it locks. 0 locks instantly.")
				.addText((t) =>
					t.setValue(String(this.plugin.settings.lockOnBlurDelaySeconds)).onChange(async (v) => {
						this.plugin.settings.lockOnBlurDelaySeconds = clampSeconds(v);
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName("Lock after inactivity")
			.setDesc("Lock automatically if there's no mouse or keyboard activity for a while.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.lockOnIdle).onChange(async (v) => {
					this.plugin.settings.lockOnIdle = v;
					await this.plugin.saveSettings();
					this.plugin.resetIdleWatcher();
					this.display();
				})
			);

		if (this.plugin.settings.lockOnIdle) {
			new Setting(containerEl)
				.setName("Idle delay (seconds)")
				.setDesc("How long the vault can sit idle before it locks.")
				.addText((t) =>
					t.setValue(String(this.plugin.settings.lockOnIdleDelaySeconds)).onChange(async (v) => {
						this.plugin.settings.lockOnIdleDelaySeconds = clampSeconds(v);
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName("Touch ID prompt reason")
			.setDesc('Shown inside the Touch ID dialog, e.g. "unlock your Obsidian vault".')
			.addText((t) =>
				t.setValue(this.plugin.settings.touchIdReason).onChange(async (v) => {
					this.plugin.settings.touchIdReason = v.trim() || DEFAULT_SETTINGS.touchIdReason;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Test Touch ID")
			.setDesc("Trigger the Touch ID prompt right now, without locking the vault, to confirm setup works.")
			.addButton((b) =>
				b.setButtonText("Run test").onClick(async () => {
					b.setDisabled(true);
					b.setButtonText("Waiting for Touch ID\u2026");
					const result = await this.plugin.runTouchIDAuth();
					b.setDisabled(false);
					b.setButtonText("Run test");
					if (result.status === "success") {
						new Notice("Touch ID succeeded.");
					} else if (result.status === "not-installed") {
						new Notice(
							"Native helper not found. Build it with native/build.sh \u2014 see the plugin README.",
							8000
						);
					} else if (result.status === "unavailable") {
						new Notice(`Touch ID unavailable: ${result.message}`, 8000);
					} else {
						new Notice(`Touch ID failed: ${result.message}`, 8000);
					}
				})
			);

		containerEl.createEl("h3", { text: "Password fallback" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Strongly recommended. Without a fallback, a Touch ID failure (sensor covered, hand injury, " +
				"external display, helper not built) leaves you unable to unlock the vault from within Obsidian.",
		});

		new Setting(containerEl)
			.setName("Enable password fallback")
			.setDesc("Show a password field on the lock screen alongside the Touch ID button.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.passwordFallbackEnabled).onChange(async (v) => {
					if (v && !this.plugin.settings.passwordHash) {
						new Notice("Set a password below before turning this on.");
						t.setValue(false);
						return;
					}
					this.plugin.settings.passwordFallbackEnabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(this.plugin.settings.passwordHash ? "Change password" : "Set password")
			.setDesc("Stored as a salted PBKDF2 hash, never in plain text.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("New password (min. 4 characters)");
				t.onChange((v) => (this.pendingPassword = v));
			})
			.addButton((b) =>
				b.setButtonText("Save").onClick(async () => {
					if (this.pendingPassword.length < 4) {
						new Notice("Password must be at least 4 characters.");
						return;
					}
					const salt = generateSalt();
					const hash = await hashPassword(this.pendingPassword, salt);
					this.plugin.settings.passwordSalt = salt;
					this.plugin.settings.passwordHash = hash;
					this.pendingPassword = "";
					await this.plugin.saveSettings();
					new Notice("Password saved.");
					this.display();
				})
			);

		if (this.plugin.settings.passwordHash) {
			new Setting(containerEl)
				.setName("Clear password")
				.setDesc("Removes the saved password and disables the fallback.")
				.addButton((b) =>
					b
						.setWarning()
						.setButtonText("Clear")
						.onClick(async () => {
							this.plugin.settings.passwordSalt = "";
							this.plugin.settings.passwordHash = "";
							this.plugin.settings.passwordFallbackEnabled = false;
							await this.plugin.saveSettings();
							new Notice("Password cleared.");
							this.display();
						})
				);
		}

		containerEl.createEl("h3", { text: "Native Touch ID helper" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"This plugin shells out to a small, signed helper binary at native/Obsidian inside the " +
				"plugin folder, which calls macOS's LocalAuthentication framework. Build it once by running " +
				"native/build.sh in Terminal \u2014 see the README included with this plugin. Your fingerprint " +
				"data never leaves the Secure Enclave and is never seen by this plugin or Obsidian.",
		});
	}
}
