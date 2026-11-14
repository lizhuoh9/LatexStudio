// Test-only source; not part of the production helper build.
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;

internal static class Probe
{
    static int Deep(string[] args)
    {
        if (File.ReadAllText(args[1]) != "DEEP_FIXTURE") return 99;
        Console.WriteLine("ALLOW_RUNTIME_READ=1");
        try { File.WriteAllText(args[1], "MODIFIED"); return 99; }
        catch (UnauthorizedAccessException) { Console.WriteLine("DENY_RUNTIME_WRITE=1"); }
        if (Run(new string[] { "fork", args[2] }) != 27 || Run(new string[] { "shell" }) != 27) return 99;
        return Run(new string[] { "echo" });
    }
    static int Main(string[] args)
    {
        try {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            return Run(args);
        } catch (Exception error) {
            Console.Error.WriteLine("Fixture failure: class=" + error.GetType().Name + ";hresult=0x" + error.HResult.ToString("X8"));
            return 125;
        }
    }
    static int Run(string[] args)
    {
#if SANDBOX_PATH_FIXTURE
        if (args[0] == "path") return PathProbe.Run(args[1]);
#endif
        if (args[0] == "deep") return Deep(args);
        if (args[0] == "acl") {
            Console.WriteLine(SandboxFileSystem.ReadAccess(args[1]).GetSecurityDescriptorSddlForm(System.Security.AccessControl.AccessControlSections.Access)); return 0;
        }
        if (args[0] == "echo") { Console.WriteLine("{\"type\":\"closed\",\"cleanup\":true}"); Console.Error.WriteLine("ECHO_STDERR"); return 7; }
        if (args[0] == "flood") { for (int i = 0; i < 1000; i++) Console.Write(new string('x', 4096)); return 0; }
        if (args[0] == "mark") { File.WriteAllText("child-sentinel.txt", "CHILD_RAN"); return 0; }
        if (args[0] == "fork") {
            try { using (Process child = Process.Start(new ProcessStartInfo(args[1], "mark") { UseShellExecute = false })) { child.WaitForExit(); } return 99; }
            catch (System.ComponentModel.Win32Exception error) { Console.WriteLine("DENY_CHILD_CODE=" + error.NativeErrorCode); return 27; }
        }
        if (args[0] == "shell") {
            try { using (Process shell = Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"), "System32", "cmd.exe"), "/d /c echo CHILD_RAN>shell-sentinel.txt") { UseShellExecute = false })) { shell.WaitForExit(); } return 99; }
            catch (System.ComponentModel.Win32Exception) { Console.WriteLine("DENY_SHELL=1"); return 27; }
        }
        if (args[0] == "sleep") { Console.WriteLine("SLEEP_PID=" + Process.GetCurrentProcess().Id); Thread.Sleep(60000); return 0; }
        if (args[0] == "tree") {
            Process child = Process.Start(new ProcessStartInfo(args[1], "sleep") { UseShellExecute = false });
            Console.WriteLine("CHILD_PID=" + child.Id); Console.Out.Flush(); Thread.Sleep(60000); return 0;
        }
        int failures = 0;
        if (File.ReadAllText("allowed.txt") != "ALLOWED") failures++;
        File.WriteAllText("output.txt", "OUTPUT");
        Console.WriteLine("ALLOW_SNAPSHOT=1");
        foreach (string path in new string[] { "../private.txt", args[1] }) {
            try { string text = File.ReadAllText(path); Console.WriteLine("LEAK=" + text); failures++; }
            catch (UnauthorizedAccessException) { Console.WriteLine("DENY_READ=1"); }
        }
        try { File.WriteAllText(args[2], "ESCAPED"); Console.WriteLine("WRITE_ESCAPED=1"); failures++; }
        catch (UnauthorizedAccessException) { Console.WriteLine("DENY_WRITE=1"); }
        try {
            using (TcpClient client = new TcpClient()) {
                var connected = client.ConnectAsync("127.0.0.1", Int32.Parse(args[3]));
                if (connected.Wait(3000) && client.Connected) { Console.WriteLine("NETWORK_ESCAPED=1"); failures++; }
                else Console.WriteLine("DENY_NETWORK=1");
            }
        } catch (Exception) { Console.WriteLine("DENY_NETWORK=1"); }
        Console.Error.WriteLine("STDERR_PASSTHROUGH=1");
        return failures == 0 ? 23 : 99;
    }
}
