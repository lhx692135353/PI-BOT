package dev.pibot.android

import dev.pibot.android.domain.containsMath
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test

class MathSyntaxTest {
    @Test fun sharedRoutingFixtures() {
        val fixtures = Json.parseToJsonElement(File(System.getProperty("markdownFixtures")).readText()).jsonArray
        for (fixture in fixtures) {
            val source = fixture.jsonObject.getValue("source").jsonPrimitive.content
            assertEquals(source, fixture.jsonObject.getValue("math").jsonPrimitive.boolean, containsMath(source))
        }
    }
}
