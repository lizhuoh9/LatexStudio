using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static partial class Sandbox
{
    internal sealed class SessionOptions {
        internal string Root, Executable, Converter, Distribution;
        internal int Timeout = 120000;
        internal bool AllowChildren = false;
        internal List<string> Work = new List<string>();
    }
    internal static SessionOptions ParseSession(string[] args)
    {
        SessionOptions options = new SessionOptions();
        int index = 0;
        while (index < args.Length && args[index] != "--") {
            string key = args[index++];
            if (index == args.Length) throw new ArgumentException("Missing session option");
            string value = args[index++];
            if (key == "--session" && value == "1") { }
            else if (key == "--runtime-root" && options.Root == null) options.Root = Canonical(value, true);
            else if (key == "--work-dir" && options.Work.Count < 2) options.Work.Add(Canonical(value, true));
            else if (key == "--tool-xdvipdfmx" && options.Converter == null) options.Converter = Canonical(value, false);
            else if (key == "--timeout-ms" && Int32.TryParse(value, out options.Timeout)) { }
#if SANDBOX_FIXTURE
            else if (key == "--fixture-allow-children" && value == "1") options.AllowChildren = true;
#endif
            else throw new ArgumentException("Invalid session option");
        }
        if (++index != args.Length - 1 || options.Root == null || options.Work.Count == 0 || options.Timeout < 100 || options.Timeout > 120000)
            throw new ArgumentException("Incomplete session policy");
        options.Executable = Canonical(args[index], false);
        ValidateSession(options);
        return options;
    }
    internal static void ValidateSession(SessionOptions options)
    {
        string name = Path.GetFileName(options.Root);
        if (!Regex.IsMatch(name, @"^paperstudio-tex-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$", RegexOptions.IgnoreCase))
            throw new ArgumentException("Runtime is not an application-managed resource");
        if (!Within(options.Root, options.Executable) || (options.Converter != null && !Within(options.Root, options.Converter)))
            throw new ArgumentException("Tool is outside managed runtime");
        foreach (string work in options.Work) {
            DirectoryInfo parent = Directory.GetParent(work);
            if (parent == null || !parent.Name.StartsWith("paperstudio-", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Work is not an isolated application snapshot");
            if (Within(options.Root, work) || Within(work, options.Root)) throw new ArgumentException("Runtime overlaps work");
        }
        if (options.Work.Count == 2 && (Within(options.Work[0], options.Work[1]) || Within(options.Work[1], options.Work[0])))
            throw new ArgumentException("Work roots overlap");
        string manifestPath = Canonical(Path.Combine(options.Root, "paperstudio-runtime.json"), false);
        if (new FileInfo(manifestPath).Length > 16384) throw new ArgumentException("Runtime manifest too large");
        Dictionary<string, object> manifest = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifestPath));
        if (manifest == null || !manifest.ContainsKey("schema") || !manifest["schema"].Equals(1) || !manifest.ContainsKey("ready") || !manifest["ready"].Equals(true)
            || !manifest.ContainsKey("platform") || !Object.Equals(manifest["platform"], "win32") || !manifest.ContainsKey("id")
            || !Object.Equals(manifest["id"].ToString().ToLowerInvariant(), name.Substring(16).ToLowerInvariant()))
            throw new ArgumentException("Runtime manifest is not ready or does not match");
        object distribution;
        if (!manifest.TryGetValue("distribution", out distribution) || !(distribution is string) || ((string)distribution != "texlive" && (string)distribution != "miktex"))
            throw new ArgumentException("Unsupported managed distribution");
        options.Distribution = (string)distribution;
    }
    internal static Options Invocation(SessionOptions session, Dictionary<string, object> request)
    {
        object id, cwd, raw;
        if (!request.TryGetValue("id", out id) || !(id is int) || (int)id < 1 || !request.TryGetValue("cwd", out cwd) || !(cwd is string)
            || !request.TryGetValue("args", out raw) || !(raw is System.Collections.IList)) throw new ArgumentException("Invalid run request");
        string work = (string)cwd;
        if (!session.Work.Contains(work, StringComparer.OrdinalIgnoreCase)) throw new ArgumentException("Unapproved work directory");
        System.Collections.IList args = (System.Collections.IList)raw;
        if (args.Count > 64 || args.Cast<object>().Any(arg => !(arg is string) || ((string)arg).Length > 2048 || ((string)arg).IndexOf('\0') >= 0))
            throw new ArgumentException("Invalid argument vector");
        object tool;
        string executable = session.Executable;
        if (request.TryGetValue("tool", out tool) && !Object.Equals(tool, "engine")) {
            if (!Object.Equals(tool, "xdvipdfmx") || session.Converter == null) throw new ArgumentException("Unapproved tool");
            executable = session.Converter;
        }
        return new Options { Work = work, Executable = executable,
            Arguments = args.Cast<string>().ToArray(), Runtime = session.Root, Distribution = session.Distribution };
    }
}
