import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TouchIDLockPlugin from "./main";
import { generateSalt, hashPassword } from "./crypto";
import { getBiometricMethodName, getBiometricPlatform, isBiometricPlatformSupported } from "./nativeAuth";
import { isWebAuthnAvailable, registerSecurityKey, type SecurityKeyInfo } from "./webauthn";

export interface TouchIDLockSettings {
	lockOnStartup: boolean;
	lockOnBlur: boolean;
	lockOnBlurDelaySeconds: number;
	lockOnIdle: boolean;
	lockOnIdleDelaySeconds: number;
	/** Prompt text shown in the biometric dialog (Touch ID and Windows Hello alike). */
	touchIdReason: string;
	passwordFallbackEnabled: boolean;
	passwordSalt: string;
	passwordHash: string;
	securityKeyEnabled: boolean;
	securityKeys: SecurityKeyInfo[];
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
	securityKeyEnabled: false,
	securityKeys: [],
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

		const method = getBiometricMethodName();

		containerEl.createEl("h2", { text: "Obsidian Fingerprint" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"This is a screen lock, not encryption \u2014 your notes are never modified or encrypted on " +
				`disk. It hides the Obsidian interface and requires ${method} (or a security key or fallback ` +
				"password) to see it again.",
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

		if (isBiometricPlatformSupported()) {
			new Setting(containerEl)
				.setName(`${method} prompt reason`)
				.setDesc(`Shown inside the ${method} dialog, e.g. "unlock your Obsidian vault".`)
				.addText((t) =>
					t.setValue(this.plugin.settings.touchIdReason).onChange(async (v) => {
						this.plugin.settings.touchIdReason = v.trim() || DEFAULT_SETTINGS.touchIdReason;
						await this.plugin.saveSettings();
					})
				);

			new Setting(containerEl)
				.setName(`Test ${method}`)
				.setDesc(`Trigger the ${method} prompt right now, without locking the vault, to confirm setup works.`)
				.addButton((b) =>
					b.setButtonText("Run test").onClick(async () => {
						b.setDisabled(true);
						b.setButtonText(`Waiting for ${method}\u2026`);
						const result = await this.plugin.runBiometricAuth();
						b.setDisabled(false);
						b.setButtonText("Run test");
						if (result.status === "success") {
							new Notice(`${method} succeeded.`);
						} else if (result.status === "not-installed") {
							new Notice(
								getBiometricPlatform() === "windows-hello"
									? "Helper script native/WindowsHelloAuth.ps1 not found \u2014 reinstall the plugin."
									: "Native helper not found. Build it with native/build.sh \u2014 see the plugin README.",
								8000
							);
						} else if (result.status === "unavailable") {
							new Notice(`${method} unavailable: ${result.message}`, 8000);
						} else {
							new Notice(`${method} failed: ${result.message}`, 8000);
						}
					})
				);
		}

		this.displaySecurityKeySection(containerEl);

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

		if (getBiometricPlatform() === "touchid") {
			containerEl.createEl("h3", { text: "Native Touch ID helper" });
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text:
					"This plugin shells out to a small, signed helper binary at native/Obsidian inside the " +
					"plugin folder, which calls macOS's LocalAuthentication framework. Build it once by running " +
					"native/build.sh in Terminal \u2014 see the README included with this plugin. Your fingerprint " +
					"data never leaves the Secure Enclave and is never seen by this plugin or Obsidian.",
			});
		} else if (getBiometricPlatform() === "windows-hello") {
			containerEl.createEl("h3", { text: "Windows Hello helper" });
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text:
					"This plugin runs a small PowerShell script at native/WindowsHelloAuth.ps1 inside the " +
					"plugin folder, which asks Windows Hello (fingerprint, face, or PIN) to verify you. " +
					"There is nothing to build or install \u2014 it works out of the box. Your biometric data " +
					"never leaves Windows and is never seen by this plugin or Obsidian.",
			});
		}
	}

	private displaySecurityKeySection(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Security keys" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Unlock with a hardware security key (YubiKey or similar) over WebAuthn. Register a key " +
				"here, then a \"Use security key\" button appears on the lock screen. Only keys registered " +
				"below can unlock the vault.",
		});

		if (!isWebAuthnAvailable()) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "WebAuthn is not available in this Obsidian build, so security keys can't be used here.",
			});
			return;
		}

		new Setting(containerEl)
			.setName("Unlock with a security key")
			.setDesc("Show a security key button on the lock screen.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.securityKeyEnabled).onChange(async (v) => {
					if (v && this.plugin.settings.securityKeys.length === 0) {
						new Notice("Register a security key below before turning this on.");
						t.setValue(false);
						return;
					}
					this.plugin.settings.securityKeyEnabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Register a security key")
			.setDesc("Insert your key, click Register, then touch the key when prompted.")
			.addButton((b) =>
				b.setButtonText("Register").onClick(async () => {
					b.setDisabled(true);
					b.setButtonText("Touch your key\u2026");
					const result = await registerSecurityKey(this.plugin.settings.securityKeys);
					b.setDisabled(false);
					b.setButtonText("Register");
					if (result.status === "registered") {
						this.plugin.settings.securityKeys.push({
							id: result.id,
							label: `Security key ${this.plugin.settings.securityKeys.length + 1}`,
							createdAt: Date.now(),
						});
						await this.plugin.saveSettings();
						new Notice("Security key registered.");
						this.display();
					} else if (result.status === "unavailable") {
						new Notice(`Can't register: ${result.message}`, 8000);
					} else {
						new Notice(`Registration failed: ${result.message}`, 8000);
					}
				})
			);

		for (const key of this.plugin.settings.securityKeys) {
			new Setting(containerEl)
				.setName(key.label)
				.setDesc(`Registered ${new Date(key.createdAt).toLocaleDateString()}`)
				.addButton((b) =>
					b
						.setWarning()
						.setButtonText("Remove")
						.onClick(async () => {
							this.plugin.settings.securityKeys = this.plugin.settings.securityKeys.filter(
								(k) => k.id !== key.id
							);
							if (this.plugin.settings.securityKeys.length === 0) {
								this.plugin.settings.securityKeyEnabled = false;
							}
							await this.plugin.saveSettings();
							new Notice("Security key removed.");
							this.display();
						})
				);
		}
	}
}
